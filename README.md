# WebAssembly Serverless Computing from Scratch

Proof of concept of a serverless computing platform in Node.js based on the idea of nanoprocesses.

![WebAssembly Serverless Computing Platform Architecture](https://raw.githubusercontent.com/ttulka/blog-assets/master/wasm-serverless/wasm-serverless-4.png)

See details at https://blog.ttulka.com/webassembly-serverless-computing-from-scratch

## Build

```sh
$ wat2wasm sum.wat -o sum.wasm
```

## Run

From source code:

```sh
$ node index.js
server is running on http://0.0.0.0:8000
```

As a Docker container:

```sh
$ docker run -p 8000:8000 -v $PWD:/app/wasm --rm ttulka/wasm-severless-from-scratch
server is running on http://0.0.0.0:8000
```

## Use

- `/register/<module>` - registers a module to the platform
- `/exec/<module>[?param1[,param2[...]]]` - executes a registered module
- `/stats/<module>` - module execution stats (consumed time, etc.)

```sh
# register a wasm module:
$ curl http://localhost:8000/register/sum
module 'sum' registered successfully

# execute a registered wasm module:
$ curl 'http://localhost:8000/exec/sum?5,2'
7

# computation stats:
$ curl http://localhost:8000/stats/sum
execution time: 6ms
number of requests: 1
```

## Configuration

| Env. variable          | Default     | Description |
| ---------------------- | ----------- | ----------- |
| `HOST`                 | `0.0.0.0`   | Host to listen on. |
| `PORT`                 | `8000`      | Port to listen on. |
| `PATH_TO_MODULES`      | `.`         | Path to Wasm files. |
| `CACHE_TTL_MS`         | `1000`      | Time-to-live in millis of loaded Wasm modules in cache. |
| `WORKER_POOL_SIZE`     | `2`         | Capacity of the worker thread pool. |
| `EXECUTION_TIMEOUT_MS` | `5000`      | Execution timeout in millis for Wasm functions. |
| `WASM_START_FUNCTION`  | `_start`    | Wasm module function name to start. |
| `MEMORY_PAGES`         | `1`         | Number of memory pages (64kB) for Wasm modules. |

## License

[MIT](https://github.com/ttulka/wasm-severless-from-scratch/blob/main/LICENSE)
