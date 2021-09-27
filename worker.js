const {parentPort} = require("worker_threads");

const START_FUNCTION = process.env.WASM_START_FUNCTION || "_start";
const MEMORY_PAGES = +process.env.MEMORY_PAGES || 1;
const IMPORT_PLATFORM = { 
  now: Date.now
};

// a new task comes
parentPort.on("message", exec);

// execute the module and send a result message
async function exec(data) {
  console.debug("execution in a worker has started")
  const result = await execModule(data);
  parentPort.postMessage(result);
}

// execute the module
async function execModule({wasmBuffer, params}) {
  try {
    const buff = new Uint8Array(wasmBuffer);  // array view on the shared buffer
    const {instance: {exports: wasm}} = await WebAssembly.instantiate(buff, {
      platform: {
        ...IMPORT_PLATFORM, 
        memory: new WebAssembly.Memory({initial: MEMORY_PAGES})
      }});
    return wasm[START_FUNCTION](...params);

  } catch (err) {
    console.error("error while executing Wasm", err);
    return err;
  }
}
