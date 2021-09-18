const fs = require("fs");
const http = require("http");
const {Worker} = require("worker_threads");

const HOST_DEFAULT = "localhost";
const PORT_DEFAULT = 8000;
const TTL_MS_DEFAULT = 1000;
const NUMBER_OF_WORKERS = 2;

class Cache {
  constructor(ttl = TTL_MS_DEFAULT) {
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

class WorkerPool {
  constructor(numberOfWorkers = NUMBER_OF_WORKERS) {
    this.total = numberOfWorkers;
    this.busy = 0;
    this.tasks = [];
  }
  async execute(wasmBuffer, params) {
    const exec = {wasmBuffer, params};
    const promise = new Promise((resolve, reject) => this.tasks.push({exec, resolve, reject}));
    this._work();
    return promise;
  }
  async _work() {
    console.debug(`attempt to execute in worker, busy workers: ${this.busy}`);
    if (this.tasks.length && this.busy < this.total) {
      this.busy++;
      const onFinish = () => {
        this.busy--;
        console.debug(`worker finished, busy workers: ${this.busy}`);
        this._work();
      };
      const task = this.tasks.pop();
      const worker = new Worker("./worker.js", {
        workerData: task.exec
      });
      worker.on("message", task.resolve);
      worker.on("error", task.reject);
      worker.on("exit", code => {
        console.debug(`worker exited with code ${code}`);
        if (code !== 0) task.reject();
        onFinish();
      });
    }
  }
}

class WasmExecutor {
  constructor() {
    this.modules = new Cache();
    this.workers = new WorkerPool();
  }
  async executeModule(wasmFile, params) {
    console.debug("executing wasm module", wasmFile, params);
    const wasmBuffer = await this.modules.get(wasmFile, this._loadWasmBuffer);
    return this.workers.execute(wasmBuffer, params);
  }
  _loadWasmBuffer(wasmFile) {
    console.debug("loading wasm buffer from file", wasmFile);
    return fs.readFileSync(wasmFile);
  }
}

class HttpServer {
  constructor(controllers, host = HOST_DEFAULT, port = PORT_DEFAULT) {
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
  _parseRequest({url}) {
    console.log('parsing request', url);
    const [controller, path] = url.substring(1).split("/");
    const [action, query] = path && path.indexOf("?") > 0 ? path.split("?") : [path, ""];
    const params = query.split(",");
    return { controller, action, params };
  }
}

class Platform {
  constructor() {
    this.wasmExecutor = new WasmExecutor();
    this.registry = new Map();
    this.server = new HttpServer({
      "exec": this.exec.bind(this),
      "register": this.register.bind(this),
      "stats": this.stats.bind(this),
    });
  }
  start() {
    this.server.start();
  }
  exec(moduleName, params) {
    if (!this.registry.has(moduleName))  {
      throw new Error(`cannot find module '${moduleName}'`);
    }
    const module = this.registry.get(moduleName);
    const [, start] = process.hrtime();
    const result = this.wasmExecutor.executeModule(module.wasmFile, params);
    const [, end] = process.hrtime();
    module.stats.time += end - start;
    return result;
  }
  register(moduleName, attributes) {
    this.registry.set(moduleName, {
      name: moduleName,
      wasmFile: `./${moduleName}.wasm`,
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
    return `time: ${module.stats.time}`;
  }
}

const platform = new Platform();
platform.start();