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

class WasmExecutor {
  constructor() {
    this.modules = new Cache();
  }
  async executeModule(wasmFile, params) {
    console.debug("executing wasm module", wasmFile, params);
    const module = await this.modules.get(wasmFile, this._loadModule);
    return module(...params);
  }
  async _loadModule(wasmFile) {
    console.debug("loading wasm from file", wasmFile);
    const {instance: {exports: wasm}} = await WebAssembly.instantiate(
      fs.readFileSync(wasmFile), IMPORT_OBJECT
    );
    return wasm[START_FUNCTION];
  }
}

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
      entry = {
        value,
        timestamp: Date.now()
      };
      this.map.set(key, entry);
    }
    return entry.value;
  }
  _evict() {    
    const toEvict = [];
    const timeout = Date.now() - this.ttl;
    for (let [key, {timestamp}] of this.map.entries()) {
      if (timestamp < timeout) {
        toEvict.push(key);
      }
    }
    toEvict.forEach(key => {
      this.map.delete(key)
    });
  };
}

class Server {
  constructor(host = HOST_DEFAULT, port = PORT_DEFAULT) {
    this.host = host;
    this.port = port;
    this.wasmExecutor = new WasmExecutor();
    this.server = http.createServer(async (req, res) => {
      const [controller, action] = req.url.substring(1).split("/");
      switch (controller) {
        case "exec":
          const [module, _query] = action.split("?");
          const params = _query.split(",");
          const result = await this.wasmExecutor.executeModule(`./${module}.wasm`, params);
          res.statusCode = 200;
          res.end(`${result}\n`);
          break;
        case "register":
          // TODO
          break;
        default:
          res.statusCode = 400;
          res.end(`wrong request ${controller}\n`);
          break;
      }
    });
  }
  start() {
    this.server.listen(this.port, this.host, () => {
      console.info(`server is running on http://${this.host}:${this.port}`);
    });
  }
  _parseRequest({url}) {
    
  }
}

const server = new Server();
server.start();