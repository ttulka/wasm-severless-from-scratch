const {parentPort, workerData} = require("worker_threads");

const START_FUNCTION = "_start";
const MEMORY_PAGES = 1;
const IMPORT_OBJECT = { 
  platform: {
    now: Date.now
  }
};

execModule(workerData)
  .then(res => parentPort.postMessage(res));

async function execModule({wasmBuffer, params}) {
  const importObject = {...IMPORT_OBJECT};
  importObject.platform.memory = new WebAssembly.Memory({initial: MEMORY_PAGES});
  const {instance: {exports: wasm}} = await WebAssembly.instantiate(wasmBuffer, importObject);
    try {
      return wasm[START_FUNCTION](...params);
    } catch (err) {
      return err;
    }
}