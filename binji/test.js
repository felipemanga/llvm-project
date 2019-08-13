class ProcExit {
  constructor(code) { this.msg = `process exited with code ${code}.`; }
  toString() { return this.msg; }
};

class NotImplemented extends Error {
  constructor(modname, fieldname) {
    super(`${modname}.${fieldname} not implemented.`);
  }
}

class AbortError extends Error {
  constructor(msg = 'abort') { super(msg); }
}

class AssertError extends Error {
  constructor(msg) { super(msg); }
}

function assert(cond) {
  if (!cond) {
    throw new AssertError('assertion failed.');
  }
}

function getModule(filename) {
  return new WebAssembly.Module(readbuffer(filename));
}

function getInstance(filename, imports) {
  const mod = getModule(filename);
  return new WebAssembly.Instance(mod, imports);
}

function getImportObject(obj, names) {
  const result = {};
  for (let name of names) {
    result[name] = obj[name].bind(obj);
  }
  return result;
}

const ESUCCESS = 0;

class Memory {
  constructor(memory) {
    this.memory = memory;
    this.buffer = this.memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }

  check() {
    if (this.buffer.byteLength === 0) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }
  }

  read8(o) { return this.u8[o]; }
  read32(o) { return this.u32[o >> 2]; }
  write8(o, v) { this.u8[o] = v; }
  write32(o, v) { this.u32[o >> 2] = v; }
  write64(o, vlo, vhi = 0) { this.write32(o, vlo); this.write32(o + 4, vhi); }

  readStr(o, len = -1) {
    let str = '';
    let end = this.buffer.byteLength;
    if (len != -1)
      end = o + len;
    for (let i = o; i < end && this.read8(i) != 0; ++i)
      str += String.fromCharCode(this.read8(i));
    return str;
  }

  writeStr(o, str) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      assert(c < 256);
      this.write8(o++, c);
    }
    this.write8(o++, 0);
    return str.length + 1;
  }
};

class HostWriteBuffer {
  constructor() {
    this.buffer = '';
  }

  write(str) {
    this.buffer += str;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      print(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  flush() {
    print(this.buffer);
  }
}

class MemFS {
  constructor() {
    this.hostWriteBuffer = new HostWriteBuffer();
    this.hostMem_ = null;  // Set later when wired up to application.

    // Imports for memfs module.
    const env = getImportObject(
        this, [ 'abort', 'host_write', 'memfs_log', 'copy_in', 'copy_out' ]);

    this.instance = getInstance('memfs', {env});
    this.exports = this.instance.exports;
    this.mem = new Memory(this.exports.memory);
    print('initializing memfs...');
    this.exports.init();
    print('done.');
  }

  set hostMem(mem) {
    this.hostMem_ = mem;
  }

  hostFlush() {
    this.hostWriteBuffer.flush();
  }

  abort() { throw new AbortError(); }

  host_write(fd, iovs, iovs_len, nwritten_out) {
    this.hostMem_.check();
    assert(fd <= 2);
    let size = 0;
    let str = '';
    for (let i = 0; i < iovs_len; ++i) {
      const buf = this.hostMem_.read32(iovs);
      iovs += 4;
      const len = this.hostMem_.read32(iovs);
      iovs += 4;
      str += this.hostMem_.readStr(buf, len);
      size += len;
    }
    this.hostMem_.write32(nwritten_out, size);
    this.hostWriteBuffer.write(str);
    return ESUCCESS;
  }

  memfs_log(buf, len) {
    this.mem.check();
    print(this.mem.readStr(buf, len));
  }

  copy_out(clang_dst, memfs_src, size) {
    this.hostMem_.check();
    const dst = new Uint8Array(this.hostMem_.buffer, clang_dst, size);
    this.mem.check();
    const src = new Uint8Array(this.mem.buffer, memfs_src, size);
    // print(`copy_out(${clang_dst.toString(16)}, ${memfs_src.toString(16)},
    // ${size})`);
    dst.set(src);
  }

  copy_in(memfs_dst, clang_src, size) {
    this.mem.check();
    const dst = new Uint8Array(this.mem.buffer, memfs_dst, size);
    this.hostMem_.check();
    const src = new Uint8Array(this.hostMem_.buffer, clang_src, size);
    // print(`copy_in(${memfs_dst.toString(16)}, ${clang_src.toString(16)},
    // ${size})`);
    dst.set(src);
  }
}


class App {
  constructor(memfs, name, ...args) {
    this.argv = [name, ...args];
    this.environ = {USER : 'alice'};
    this.memfs = memfs;

    const wasi_unstable = getImportObject(this, [
      'proc_exit', 'environ_sizes_get', 'environ_get', 'args_sizes_get',
      'args_get', 'random_get', 'clock_time_get', 'poll_oneoff'
    ]);

    // Fill in some WASI implementations from memfs.
    Object.assign(wasi_unstable, this.memfs.exports);

    this.instance = getInstance(name, {wasi_unstable});
    this.exports = this.instance.exports;
    this.mem = new Memory(this.exports.memory);
    this.memfs.hostMem = this.mem;

    print(`running ${name}...`);
    this.instance.exports._start();
    print('done.');
  }

  proc_exit(code) {
    throw new ProcExit(code);
  }

  environ_sizes_get(environ_count_out, environ_buf_size_out) {
    this.mem.check();
    let size = 0;
    const names = Object.getOwnPropertyNames(this.environ);
    for (const name of names) {
      const value = this.environ[name];
      // +2 to account for = and \0 in "name=value\0".
      size += name.length + value.length + 2;
    }
    this.mem.write64(environ_count_out, names.length);
    this.mem.write64(environ_buf_size_out, size);
    return ESUCCESS;
  }

  environ_get(environ_ptrs, environ_buf) {
    this.mem.check();
    const names = Object.getOwnPropertyNames(this.environ);
    for (const name of names) {
      this.mem.write32(environ_ptrs, environ_buf);
      environ_ptrs += 4;
      environ_buf +=
          this.mem.writeStr(environ_buf, `${name}=${this.environ[name]}`);
    }
    this.mem.write32(environ_ptrs, 0);
    return ESUCCESS;
  }

  args_sizes_get(argc_out, argv_buf_size_out) {
    print(JSON.stringify(this.argv));
    this.mem.check();
    let size = 0;
    for (let arg of this.argv) {
      size += arg.length + 1;  // "arg\0".
    }
    this.mem.write64(argc_out, this.argv.length);
    this.mem.write64(argv_buf_size_out, size);
    return ESUCCESS;
  }

  args_get(argv_ptrs, argv_buf) {
    this.mem.check();
    for (let arg of this.argv) {
      this.mem.write32(argv_ptrs, argv_buf);
      argv_ptrs += 4;
      argv_buf += this.mem.writeStr(argv_buf, arg);
    }
    this.mem.write32(argv_ptrs, 0);
    return ESUCCESS;
  }

  random_get(buf, buf_len) {
    const data = new Uint8Array(this.mem.buffer, buf, buf_len);
    for (let i = 0; i < buf_len; ++i) {
      data[i] = (Math.random() * 256) | 0;
    }
  }

  clock_time_get(clock_id, precision, time_out) {
    throw new NotImplemented('wasi_unstable', 'clock_time_get');
  }

  poll_oneoff(in_ptr, out_ptr, nsubscriptions, nevents_out) {
    throw new NotImplemented('wasi_unstable', 'poll_oneoff');
  }
}

const memfs = new MemFS();
// new App(memfs, 'clang', '--help');
new App(memfs, 'clang', '-cc1', '-emit-obj', 'test.c', '-o', 'test.o');
// new App(memfs, 'clang', '-cc1', '-S', 'test.c', '-o', '-');

memfs.hostFlush();
