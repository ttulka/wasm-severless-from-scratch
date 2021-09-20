const fs = require("fs");
const http = require("http");
const {Worker} = require("worker_threads");

const HOST = "localhost";
const PORT = 8000;
const CACHE_TTL_MS = 1000;
const WORKER_POOL_SIZE = 2;
const EXECUTION_TIMEOUT_MS = 5000;

// general key-value cache with eviction after TTL
class Cache {
  constructor(ttl = CACHE_TTL_MS) {
    this.ttl = ttl;
    this.map = new Map();
    const evictFn = this._evict.bind(this);
    setInterval(evictFn, this.ttl);
  }
  async get(key, supplyFn) {
    let entry = this.map.get(key);
    if (!entry) {
      const value = await supplyFn(key);
      entry = { value };
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
    this.poolSize = poolSize; // max count of workers
    this.busy = 0;    // currently busy workers
    this.tasks = [];  // executions are queued as tasks
    this.modules = new Cache(); // modules are cached to optimize against cold starts
  }
  async execute(wasmFile, params, onFinish) {
    console.debug("executing wasm module", wasmFile, params);
    const wasmBuffer = await this.modules.get(wasmFile, this._loadWasmBuffer);
    const exec = {wasmBuffer, params};
    const promise = new Promise((_resolve, _reject) => {
      const resolve = (result, stats) => {
        _resolve(result);
        onFinish(stats);
      };
      const reject = (error, stats) => {
        _reject(error);
        onFinish(stats);
      };
      this.tasks.push({exec, resolve, reject}); // defer execution when there is a free worker
    });
    this._work();   // trigger task polling
    return promise; // return a promise of a future execution
  }
  async _loadWasmBuffer(wasmFile) {
    console.debug("loading wasm buffer from file", wasmFile);
    return fs.readFileSync(wasmFile);
  }
  // polls a task from the queue and executes on a free worker
  async _work() {
    console.debug(`attempt to execute in worker, busy workers: ${this.busy}`);
    // are there free workers?
    if (!this.tasks.length || this.busy >= this.poolSize) {
      return;
    }
    // start execution on a worker
    const time_start = Date.now();
    this.busy++;
    let running = true;
    const onFinish = () => {
      this.busy--;
      running = false;
      console.debug(`worker finished, busy workers: ${this.busy}`);
      this._work(); // trigger task polling when this worker finished
    };
    const createStats = () => ({time: Date.now() - time_start});  // collect execution time
    // pop another task from the queue
    const task = this.tasks.pop();
    // create a new worker instance
    const worker = new Worker("./worker.js", {
      workerData: task.exec
    });
    worker.on("message", result => task.resolve(result, createStats()));
    worker.on("error", error => task.reject(error, createStats()));
    worker.on("exit", code => {
      console.debug(`worker exited with code ${code}`);
      if (code !== 0) task.reject(`Exit code ${code}`, createStats());
      onFinish();
    });
    // kill the worker when timeout is reached
    setTimeout(() => {
      if (running) {
        console.warn("timout reached; killing worker");
        worker.terminate();
      }
    }, EXECUTION_TIMEOUT_MS);
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
    if (!this.registry.has(moduleName))  {  // execute only already registered modules
      throw new Error(`cannot find module '${moduleName}'`);
    }
    const module = this.registry.get(moduleName);
    // return a promise of a future execution
    return this.wasmExecutor.execute(
      module.wasmFile, params, ({time}) => module.stats.time += time);
  }
  register(moduleName, attributes) {
    this.registry.set(moduleName, {
      name: moduleName,
      wasmFile: `./${moduleName}.wasm`, // search for modules by name in the root directory
      stats: {
        time: 0
      }
    });
    return `module '${moduleName}' registered successfully`;
  }
  stats(moduleName) {
    if (!this.registry.has(moduleName))  {
      throw new Error(`cannot find module '${moduleName}'`);
    }
    const module = this.registry.get(moduleName);
    return `execution time: ${module.stats.time}ms`;  // print stats
  }
}

const platform = new Platform();
platform.start();