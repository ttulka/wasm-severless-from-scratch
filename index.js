const fs = require("fs");
const http = require("http");
const {Worker} = require("worker_threads");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = +process.env.PORT || 8000;
const PATH_TO_MODULES = process.env.PATH_TO_MODULES || "."
const CACHE_TTL_MS = +process.env.CACHE_TTL_MS || 1000;
const WORKER_POOL_SIZE = +process.env.WORKER_POOL_SIZE || 2;
const EXECUTION_TIMEOUT_MS = +process.env.EXECUTION_TIMEOUT_MS || 5000;

// key-value cache for SharedArrayBuffer values with eviction after TTL
class SharedBufferCache {
  constructor(ttl = CACHE_TTL_MS) {
    this.ttl = ttl;
    this.map = new Map();
    const evictFn = this._evict.bind(this);
    setInterval(evictFn, this.ttl);
  }
  async get(key, supplyBufferFn) {
    let entry = this.map.get(key);
    if (!entry) {
      const data = await supplyBufferFn(key);
      // wrap data into a shared buffer
      const sharedBuffer = new SharedArrayBuffer(data.length);
      const buffer = Buffer.from(sharedBuffer);
      buffer.set(data);
      // store into the cache
      entry = {value: sharedBuffer};
      this.map.set(key, entry);
    }
    entry.timestamp = Date.now();
    return entry.value;
  }
  _evict() {
    const timeout = Date.now() - this.ttl;
    Array.from(this.map.entries())
      .filter(([key, {timestamp}]) => timestamp < timeout)
      .forEach(([key]) => this.map.delete(key));
  };
}

// implements the platform API
class HttpServer {
  constructor(controllers, host = HOST, port = PORT) {
    this.controllers = controllers;
    this.host = host;
    this.port = port;
    this.server = http.createServer(this._processRequest.bind(this));
  }
  start() {
    this.server.listen(this.port, this.host, () => {
      console.info(`server is running on http://${this.host}:${this.port}`);
    });
  }
  async _processRequest(req, res) {
    const request = this._parseRequest(req);
    const controllerFn = this.controllers[request.controller];
    if (controllerFn) {
      try {
        const result = await controllerFn(request.action, request.params);
        res.statusCode = 200;
        res.end(`${result}`);
      } catch (err) {
        console.error(err);
        res.statusCode = 500;
        res.end(err.toString());
      }
    } else {
      res.statusCode = 400;
      res.end(`wrong request ${request.controller}\n`);
    }
  }
  // parses requests in format `/<controller>/<actio>[?param1[,param2[...]]]`
  _parseRequest({url}) {
    console.log('parsing request', url);
    const [controller, path] = url.substring(1).split("/");
    const [action, query] = path && path.indexOf("?") > 0 ? path.split("?") : [path, ""];
    const params = query.split(",");
    return { controller, action, params };
  }
}

// excutes Wasm module in a worker pool
class WasmThreadExecutor {
  constructor(poolSize = WORKER_POOL_SIZE) {
    this.threads = Array(poolSize); // pool of workers
    this.tasks = [];  // executions are queued as tasks
    this.cache = new SharedBufferCache(); // modules are cached to optimize against cold starts
    // setInterval(this._work.bind(this), 1000);  // periodically trigger to avoid lock-ins
  }
  async execute(wasmFile, params, onFinish) {
    console.debug("executing wasm module", wasmFile, params);    
    // promise of execution will be fulfilled by a worker
    const promise = new Promise((_resolve, _reject) => {
      // wrappers for the promise of execution
      const resolve = (result, stats) => {
        _resolve(result); // resolve the promise
        onFinish(stats);  // callback hook of the platform
      };
      const reject = (error, stats) => {
        _reject(error);   // reject the promise
        onFinish(stats);  // callback hook of the platform
      };
      // push the promise as a new task for workers
      this.tasks.push({wasmFile, params, resolve, reject}); // defers execution for a free worker
    });
    this._triggerWork();   // trigger task polling
    return promise; // return a promise of a future execution
  }
  // polls a task from the queue and attempts to execute on a free worker
  async _triggerWork() {
    // are there task to execute?
    if (!this.tasks.length) return;
    // are there free workers?
    const thread = this._findFreeWorker();
    if (!thread) return;
    // pop another task from the queue
    const task = this.tasks.pop();
    // start async execution on a worker
    this._work(task, thread);
  }
  // executes a task on a worker thread
  async _work(task, thread) {
    const time_start = Date.now();
    thread.busy = true;
    // kill the worker when timeout is reached
    let timeoutReached = false;
    const timeoutId = this._setupWorkTimeout(thread, () => timeoutReached = true);
    // execution finished callback
    const onWokerFinished = callback => {
      clearTimeout(timeoutId);
      thread.busy = false;
      console.debug(`worker finished, busy workers: ${this._countOfBusyWorkers()}, tasks: ${this.tasks.length}`);
      if (callback) callback(); // execute the callback
      this._triggerWork(); // trigger task polling when this worker finished
    };
    const createStats = () => ({time: Date.now() - time_start});  // collect execution time
    // setup the worker     
    thread.onMessage = result => onWokerFinished(() => task.resolve(result, createStats()));
    thread.onError = error => onWokerFinished(() => task.reject(error, createStats()));
    thread.onExit = code => {
      console.debug(`worker exited with code ${code}`);
      if (code !== 0) {
        if (timeoutReached) task.reject(`timeout after ${EXECUTION_TIMEOUT_MS}ms`, createStats());
        else task.reject(`exit code ${code}`, createStats());
      }
      onWokerFinished();
    };
    // get a module from the cache or load it
    const wasmBuffer = await this.cache.get(task.wasmFile, this._loadWasmBuffer);
    // run on the worker
    thread.worker.postMessage({wasmBuffer, params: task.params});
  }
  _setupWorkTimeout(thread, callback) {
    return setTimeout(() => {
      console.warn("timeout reached; killing worker");
      thread.worker.terminate();
      this.threads[thread.index] = null;  // remove the worker from the pool
      if (callback) callback();
    }, EXECUTION_TIMEOUT_MS);
  }
  _findFreeWorker() {
    for (let i = 0; i < this.threads.length; i++) {
      const thread = this.threads[i];
      if (!thread) {
        // create a new worker
        console.debug(`creating a new worker ${i}`);
        this.threads[i] = this._createWorker(i);
        return this.threads[i];
      } 
      if (!thread.busy) {
        console.debug(`returning a free worker ${i}`);
        return thread;
      }
    }
    console.debug("all workers are busy");
    return null;
  }
  _createWorker(index) {
    const worker = new Worker("./worker.js");
    const thread = {
      worker, 
      index, 
      busy: false, 
      onMessage: result => {},
      onError: error => {},
      onExit: code => {}
    };
    worker.on("message", result => thread.onMessage(result));
    worker.on("error", error => thread.onError(error));
    worker.on("exit", code => thread.onExit(code));
    return thread;
  }
  _countOfBusyWorkers() {
    return this.threads.filter(t => t && t.busy).length;
  }
  async _loadWasmBuffer(wasmFile) {
    console.debug("loading wasm buffer from file", wasmFile);
    return fs.readFileSync(wasmFile);
  }
}

// the platform implementation
class Platform {
  constructor() {
    this.wasmExecutor = new WasmThreadExecutor(); // worker-based execution of Wasm modules
    this.registry = new Map();  // keep registered modules in memory
    this.server = new HttpServer({
      "exec": this.exec.bind(this),
      "register": this.register.bind(this),
      "stats": this.stats.bind(this),
    });
  }
  start() {
    this.server.start();  // start the HTTP server
  }
  exec(moduleName, params) {
    console.debug(`executing the module '${moduleName}' with parameters`, params);
    if (!this.registry.has(moduleName))  {  // execute only already registered modules
      throw new Error(`cannot find module '${moduleName}'`);
    }
    const module = this.registry.get(moduleName);
    // return a promise of a future execution
    return this.wasmExecutor.execute(module.wasmFile, params, ({time}) => {
        module.stats.time += time;
        module.stats.counter++;
      })
      .catch(err => console.error(`error by executing the module '${moduleName}' with parameters`, params, err));
  }
  register(moduleName, attributes) {
    console.debug(`registering the module '${moduleName}' with attributes`, attributes);
    const wasmFile = `${PATH_TO_MODULES}/${moduleName}.wasm`;  // search for modules by name in the root directory
    if (!fs.existsSync(wasmFile)) throw new Error(`module not found in '${wasmFile}'`);
    this.registry.set(moduleName, {
      name: moduleName,
      wasmFile,
      stats: {
        time: 0,
        counter: 0,
      }
    });
    return `module '${moduleName}' registered successfully`;
  }
  stats(moduleName) {
    console.debug(`printing statistics for the module '${moduleName}'`);
    if (!this.registry.has(moduleName))  {
      throw new Error(`cannot find module '${moduleName}'`);
    }
    const module = this.registry.get(moduleName);
    // print stats
    return `execution time: ${module.stats.time}ms\nnumber of requests: ${module.stats.counter}`;  
  }
}

const platform = new Platform();
platform.start();