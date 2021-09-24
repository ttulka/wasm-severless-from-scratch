const {parentPort} = require("worker_threads");

const START_FUNCTION = "_start";
const MEMORY_PAGES = 1;
const IMPORT_PLATFORM = { 
  now: Date.now
};

// a new task came
parentPort.on("message", exec);

// execute the module and send a result message
async function exec(data) {
  console.debug("execution in a worker has started")
  execModule(data).then(res => parentPort.postMessage(res));
}

// execute the module
async function execModule({wasmBuffer, params}) {
  const {instance: {exports: wasm}} = await WebAssembly.instantiate(wasmBuffer, {
    platform: {
      ...IMPORT_PLATFORM, 
      memory: new WebAssembly.Memory({initial: MEMORY_PAGES})
    }});
  try {
    return wasm[START_FUNCTION](...params);
  } catch (err) {
    return err;
  }
}

// keep the worker alive
new Promise((resolve, reject) => parentPort.on("close", () => {
  console.debug('CLOSE');
  resolve()
}));
