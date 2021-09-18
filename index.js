const fs = require("fs");
const http = require("http");

const HOST_DEFAULT = "localhost";
const PORT_DEFAULT = 8000;
const START_FUNCTION = "_start";
const TTL_MS_DEFAULT = 1000;
const IMPORT_OBJECT = { 
  platform: {
    now: Date.now
  }
};

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

class WasmExecutor {
  constructor() {
    this.modules = new Cache();
  }
  async executeModule(wasmFile, params) {
    console.debug("executing wasm module", wasmFile, params);
    const wasmBuffer = await this.modules.get(wasmFile, this._loadWasmBuffer);
    const module = await this._instantiateModule(wasmBuffer);
    return module(...params);
  }
  async _instantiateModule(wasmBuffer) {
    const memory = new WebAssembly.Memory({initial:1});
    const {instance: {exports: wasm}} = await WebAssembly.instantiate(
      wasmBuffer, 
      {...IMPORT_OBJECT, platform: { memory }}
    );
    return wasm[START_FUNCTION];
  }
  _loadWasmBuffer(wasmFile) {
    console.debug("loading wasm buffer from file", wasmFile);
    return fs.readFileSync(wasmFile);
  }
}

class Server {
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
    this.server = new Server({
      "exec": this.exec.bind(this),
      "register": this.register.bind(this)
    });
  }
  start() {
    this.server.start();
  }
  exec(moduleName, params) {
    if (this.registry.has(moduleName))  {
      const module = this.registry.get(moduleName);
      return this.wasmExecutor.executeModule(module.wasmFile, params);
    }
    throw new Error(`cannot find module '${moduleName}'`);
  }
  register(module, attributes) {
    this.registry.set(module, {
      wasmFile: `./${module}.wasm`
    });
    return `module '${module}' registered successfully`;
  }
}

const platform = new Platform();
platform.start();