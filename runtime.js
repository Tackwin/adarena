"use strict";

// These are all the functions that we declared as "#foreign" in our Jai code.
// They let you interact with the JS and DOM world from within Jai.
const jai_imports = {};

// TODO: Thinking about the compiling a library, we would need a lot of the same jmp_buf logic, but instead of calling main
//       we are calling something from jai_exports. The only difference is that instead of simply returning when the wasm
//       is paused, we have to do something like return a Promise that gets resolve()ed when we exit normally (maybe listening
//       for wasm_exit would be enough.....). TLDR; I still don't know how to factor this out yet

// TODO: document why this is not inline and the whole pause/resume thing

// TODO: we should expose a helper that genetrates thesew definitions, or just generates the read/write code
//       from jai that you can paste in where needed
const source_code_location_struct_info = {
    type: "struct",
    members: [
        { name: "fully_pathed_filename", offset:   0, type: "string" },
        { name: "line_number",           offset:  16, type: "s64" },
        { name: "character_number",      offset:  24, type: "s64" },
    ],
};

const stack_trace_procedure_info_struct_info = {
    type: "struct",
    members: [
        { name: "name",              offset:  0, type: "string" },
        { name: "location",          offset: 16, ...source_code_location_struct_info },
        { name: "procedure_address", offset: 48, type: "u64" },
    ]
};

const stack_trace_node_struct_info = {
    type: "struct",
    members: [
        { name: "next",        offset:  0, type: "pointer_to_this" },
        { name: "info",        offset:  8, type: "pointer", pointing_to: stack_trace_procedure_info_struct_info },
        { name: "hash",        offset: 16, type: "u64" },
        { name: "call_depth",  offset: 24, type: "u32" },
        { name: "line_number", offset: 28, type: "u32" },
    ]
};
   
const copy_any_to_js = (address, type_info, view = undefined) => {
    view ??= new DataView(jai_exports.memory.buffer);
    
    if (address === 0n) return null;
    try {
        switch (type_info.type) {
        case "pointer": {
            const next_address = view.getBigUint64(Number(address), true);
            return copy_any_to_js(next_address, type_info.pointing_to, view);
        }
        case "struct": {
            const struct = {};
            for (const it of type_info.members) {
                const info = (it.type === "pointer_to_this") ? { type: "pointer", pointing_to: type_info } : it;
                const result = copy_any_to_js(Number(address) + it.offset, info, view);
                struct[it.name] = result;
            }
            return struct;
        }
        case "string": {
            const count = view.getBigUint64(Number(address) + 0, true);
            const data  = view.getBigUint64(Number(address) + 8, true);
            return copy_string_to_js(count, data, false);
        }
        case "float": return view.getFloat32(Number(address), true);
        case "u64":   return view.getBigUint64(Number(address), true);
        case "s64":   return view.getBigInt64(Number(address), true);
        case "u32":   return view.getUint32(Number(address), true);
        case "s32":   return view.getInt32(Number(address), true);
        case "u16":   return view.getUint16(Number(address), true);
        case "s16":   return view.getInt16(Number(address), true);
        case "u8":    return view.getUint8(Number(address), true);
        case "s8":    return view.getInt8(Number(address), true);
        default: {
            throw "Unimplemented data type " + definition.type
        }
        }
    } catch (e) {
        // If an address is out of bounds of the memory we return
        // undefined instead of crashing. So if you get an object
        // whose fields are all undefined, it means that the pointer
        // was somehow corrupted and we tried to read memory out of bounds. 
        return undefined;
    }
};


const log_context_stack_trace = (ident) => {
    const view = new DataView(jai_exports.memory.buffer);
    const context_stack_trace_address = Number(jai_context+72n); // **Stack_Trace_Node or *context.stack_trace
    const stack_trace_address = view.getBigInt64(context_stack_trace_address, true);
    const stack_trace = copy_any_to_js(stack_trace_address, stack_trace_node_struct_info, view);
    console.log(`[${ident}] context.stack_trace = 0x${stack_trace_address.toString(16)}`, stack_trace);
}

const entry_point = () => {
    while (true) {
        try {
            jai_exports.__program_main(jai_context);
        } catch (e) {
            create_fullscreen_canvas("Program exited due to an exception.\nSee console for details.");
            console.error(e);
            return;
        }
        
        // The exit from main was the application actually exitting
        if (active_jmp_buf === 0n) {
            null_context_stack_trace(); // :WasmNullStackTrace:
            jai_imports.js_exit(0);
            null_context_stack_trace(); // :WasmNullStackTrace:
            return;
        }
        
        // The exit from main happened because the we are either doing setjmp/longjmp stuff or we are pausing execution.
        jai_exports.asyncify_stop_unwind();
        
        
        // wasm_prepare_rewind returns true if active_jmp_buf was unwound with
        // the intention of being rewound immediately (setjmp was called)
        // and returns false if active_jmp_buf was unwound with the intent
        // of being rewound at a later point (wasm_pause was called).
        if (wasm_prepare_for_rewind()) {
            jai_exports.asyncify_start_rewind(active_jmp_buf);
        } else {
            // do NOT rewind and do NOT re-enter __program_main
            return;
        }
    }
};

let pwa_manifest;
let websocket;

let web_buffer = new Uint8Array(1024*1024*32);
let web_buffer_cursor = 0;

window.addEventListener("load", async () => {
    websocket = new WebSocket("wss://89.88.83.151:2356/ws");
    websocket.addEventListener("message", async event => {
        // Append event.data to web_buffer at web_buffer_cursor
        const blob = event.data;
        const buffer = await blob.arrayBuffer();
        const data = new Uint8Array(buffer);
        // const data = new Uint8Array(await event.data.arrayBuffer());
        if (web_buffer_cursor + data.length > web_buffer.length) {
            console.error("Web buffer overflow, dropping message");
            return;
        }

        web_buffer.set(data, web_buffer_cursor);
        web_buffer_cursor += data.length;
    });

    // We use the PWA manifest to store paths to cached assets in addition to metadata about the application
    const response = await fetch(document.querySelector('link[rel="manifest"]').href);
    pwa_manifest   = await response.json();
    document.title = pwa_manifest.name;
    
    await initialize_wasm_module("main.wasm", pwa_manifest.initial_pages);
    
    entry_point();
});

window.addEventListener("wasm_exit", (e) => {
    if (e.code === 0) {
        // Because a PWA is a long running interactive application, it isn't expected you will exit unless something
        // bad happens. Reloading the page makes games like Invaders restart when you lose which seems like reasonable
        // enough behaviour for most programs written in this style.    -nzizic, 27 June 2025
        window.location.reload();
    } else {
        // Remove any existing canvases so that the user can see the error code message
        document.querySelectorAll("canvas").forEach(canvas => canvas.remove());
        window.addEventListener("click", (event) => window.location.reload());
        create_fullscreen_canvas(
            `Program exited with error code ${e.code}.\n`+
            "Press Ctrl+Shift+I for more information.\n"
        );
    }
});

const create_fullscreen_canvas = (text) => {
    const canvas  = document.createElement("canvas");
    canvas.id     = "fullscreen_canvas";
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.position  = "absolute";
    canvas.style.left      = "50%";
    canvas.style.top       = "50%";
    canvas.style.transform = "translate(-50%, -50%)";
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext("2d");
    ctx.fillStyle    = "white";
    ctx.font         = "60px Georgia";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    
    const lines = text.split("\n");
    const line_height  = 70;
    const total_height = lines.length * line_height;
    lines.forEach((line, index) => {
        const y = (canvas.height / 2) - (total_height / 2) + (index * line_height);
        ctx.fillText(line, canvas.width / 2, y);
    });
};



/*

Module Basic platform layer inserted from C:/Users/Tackwin/Documents/Code/jai/modules/Toolchains/Web/libjs/Basic.js

*/

const time_origin = Date.now();
jai_imports.js_get_microseconds = () => {
    return BigInt((Number(time_origin) + Number(performance.now())) * 1000);
};

jai_imports.js_sleep_milliseconds = (ms) => {
    if (wasm_pause() === 0) setTimeout(() => { wasm_resume(1); }, ms);
};

jai_imports.js_set_working_directory = (path_count, path_data, path_is_constant) => {
    switch (wasm_pause()) {
    case 0: (async () => {
        const path   = copy_string_to_js(path_count, path_data, path_is_constant);
        const handle = await opfs_find_directory(path);
        if (handle === undefined) {
            set_resume_error(`Could not set working directory to "${path}": directory does not exist`);
            return -1;
        }
        
        opfs_current_working_directory = handle;
        return +1;
    })().then(wasm_resume); break;
    case +1: return true;
    case -1: {
        log_resume_error();
        return false;
    }
    }
};

const copy_array_to_js = (count, data) => {
    const u8 = new Uint8Array(jai_exports.memory.buffer)
    const bytes = u8.subarray(Number(data), Number(data) + Number(count));
    return bytes;
}
jai_imports.js_send_web_message = (data, length) => {
    if (websocket.readyState != WebSocket.OPEN)
        return;
    const x = copy_array_to_js(length, data);
    websocket.send(x);
};



/*

Module Runtime_Support platform layer inserted from C:/Users/Tackwin/Documents/Code/jai/modules/Toolchains/Web/libjs/Runtime_Support.js

*/

// Runtime_Support does not schedule for the wasm application to be loaded. We do this so that 
// See Toolchains/Web/Progressive_Web_App.jai (and PWA_JS_HEADER in particular) for example usage.
// There currently isn't support for loading multiple wasm modules on a single page.
const initialize_wasm_module = async (module_path, initial_pages = 0) => {
    // If you forget to implement something jai_imports expects, the Proxy below will log a nice error.
    const imports = {
        "env": new Proxy(jai_imports, {
            get(target, prop, receiver) {
                // if (prop === "memcpy") throw new Error("these");
                if (target.hasOwnProperty(prop)) return target[prop];
                return () => { throw new Error("Missing function: " + prop); };
            },
        }),
        
        "memory": new WebAssembly.Memory({"initial": initial_pages}),
        
        // TODO: look into this
        // __memory_base: 256, // from https://www.tutorialspoint.com/webassembly/webassembly_dynamic_linking.htm idk why
    };
    
    
    // load the wasm module and extract what we want from it
    const module = await WebAssembly.instantiateStreaming(fetch(module_path), imports);
    jai_exports  = module.instance.exports;
    jai_context  = jai_exports.__jai_runtime_init(0, 0n);
    // log_context_stack_trace("init");
    
    // allocate space for unwinding and rewinding the callstack
    const memory = jai_exports.context_alloc(jai_context, JMP_BUF_SIZE*2n);
    null_context_stack_trace(); // :WasmNullStackTrace:
    
    jmp_buf_for_pausing = memory;
    jmp_buf_init(jmp_buf_for_pausing);
    
    jmp_buf_for_garbage = memory+JMP_BUF_SIZE;
    jmp_buf_init(jmp_buf_for_garbage);
    
    opfs_home_folder               = await opfs_ensure_path_exists(document.location.pathname, true);
    opfs_current_working_directory = opfs_home_folder;
    opfs_copied_files_folder       = await opfs_ensure_path_exists(OPFS_COPIED_FILES_PATH, true);
}



let jai_exports; // contains procedures and globals from the loaded wasm module
let jai_context; // *Runtime_Support.first_thread_context

// Used by the js runtime to pause and resume the
// wasm module when waiting for async APIs
let jmp_buf_for_pausing;

// In order to implement longjmp we have to unwind the current
// stack and then never rewind back to it, so we the runtime
// allocates another jmp_buf in initialize_wasm_module()
// that we reuse every time we want to unwind a stack and
// never return.
let jmp_buf_for_garbage;


// We create a "home folder" for the application so that multiple applications served by the same origin
// do not trample eachothers files. We use document.location.pathname because it mirrors the location
// of the wasm module relative to the server. So if you had a wasm module being served from
// www.mycoolwebsite.com/tools/foozler the home folder would be "/tools/foozler"
let opfs_home_folder;               // set by initialize_wasm_module()
let opfs_current_working_directory; // initially set to opfs_home_folder
let opfs_copied_files_folder;       // for files copied from the system (drag and drop, open file dialog, etc)

// Although we have a notion of a program's home folder, we have a "global" place for
// files generated from the client's *real* file system. This is because we already mark
// filenames that we generate with a timestamp to disambiguate files with the same name.
const OPFS_COPIED_FILES_PATH = "/__jai_runtime_copied_files/";


/*

Exports needed for Runtime_Support.jai and the C code included with the Jai distribution

*/

// TODO: this should not be necesarry, but it is.....
jai_imports.memcmp = (a, b, count) => {
    const [na, nb, nc] = [Number(a), Number(b), Number(count)];
    const u8    = new Uint8Array(jai_exports.memory.buffer);
    const buf_a = u8.subarray(na, na + nc);
    const buf_b = u8.subarray(nb, nb + nc);
    for (let i = 0; i < count; i++) {
        const delta = Number(buf_a[i]) - Number(buf_b[i]);
        if (delta !== 0) return delta;
    }
    return 0;
};

jai_imports.js_write_string = (s_count, s_data, to_standard_error) => {
    // since this is only called by write_string_unsynchronized we do not pass is_constant
    const js_string = copy_string_to_js(s_count, s_data, false);
    write_to_console_log(js_string, to_standard_error);
};

jai_imports.js_debug_break = () => { debugger; };

// Here we dispatch an event so that the specifics of what happens when an application exits is left to the "js header".
// This way a library could call reject() on a promise representing the current call while a PWA could just reload the page.
jai_imports.js_exit = (code) => {
    const event = new Event("wasm_exit");
    event.code  = code;
    window.dispatchEvent(event);
    wasm_pause();
};

jai_imports.js_alloca = (size) => jai_exports.temporary_alloc(jai_context, size);

// for c code that needs math.h
jai_imports.js_log   = Math.log;
jai_imports.js_exp   = Math.exp;
jai_imports.js_pow   = Math.pow;
jai_imports.js_sin   = Math.sin;
jai_imports.js_cos   = Math.cos;
jai_imports.js_abs   = Math.abs;
jai_imports.js_floor = Math.floor;

// freetype checks this for some settings of whatever, put some stuff here
// if you actually want to expose environment variables to wasm
jai_imports.js_getenv = (_name) => {
    return 0n;
};




let active_jmp_buf = 0n;

jai_imports.js_setjmp = (jmp_buf) => {
    const view = new DataView(jai_exports.memory.buffer);
    const buf  = Number(jmp_buf);
    
    
    // This checks wether this is the initial call to setjmp
    // That wasn't called as part of a wasm_pause. We clear 
    // the memory here because setjmp could be called by some
    // C code that allocated the jmp_buf on the stack and did not
    // initialize it.
    if (active_jmp_buf === 0n && jmp_buf !== jmp_buf_for_pausing) {
        view.setBigInt64(buf + JMP_BUF_OFFSET_TOP, 0n, true);
        view.setBigInt64(buf + JMP_BUF_OFFSET_END, 0n, true);
        view.setBigInt64(buf + JMP_BUF_OFFSET_UNWOUND, 0n, true);
        view.setInt32(buf + JMP_BUF_OFFSET_STATE, 0, true);
        view.setInt32(buf + JMP_BUF_OFFSET_VALUE, 0, true);
    }
    
    if (active_jmp_buf !== 0n && active_jmp_buf !== jmp_buf) throw new Error(`unreachable? ${active_jmp_buf} ${jmp_buf}`);
    
    const state = view.getInt32(buf + JMP_BUF_OFFSET_STATE, true);
    if (state === JMP_BUF_STATE_INITIALIZED) {
        view.setInt32(buf + JMP_BUF_OFFSET_VALUE, 0, true);
        view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_CAPTURING, true);
        
        active_jmp_buf = jmp_buf;
        jmp_buf_init(jmp_buf);
        jai_exports.asyncify_start_unwind(jmp_buf);
        
        return 0; 
    } else if (state === JMP_BUF_STATE_CAPTURING) {
        if (active_jmp_buf !== jmp_buf) throw new Error(`unreachable? ${active_jmp_buf} ${jmp_buf}`);
        view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_CAPTURED, true);
        active_jmp_buf = 0n;
        jai_exports.asyncify_stop_rewind();
        return 0;
    } else if (state === JMP_BUF_STATE_RETURNING) {
        jai_exports.asyncify_stop_rewind();
        view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_CAPTURED, true);
        active_jmp_buf = 0n;
        return view.getInt32(buf + JMP_BUF_OFFSET_VALUE, true);
    } else {
        throw new Error(`unreachable jmp_buf state ${state}`);
    }
};

jai_imports.js_longjmp = (jmp_buf, value) => {
    if (active_jmp_buf !== 0n) throw new Error(`Unreachable? ${active_jmp_buf} ${jmp_buf}`);
    if (value === 0) throw new Error("Dude do not pass 0 to longjmp what is wrong with you?");
    
    const view = new DataView(jai_exports.memory.buffer);
    const buf  = Number(jmp_buf);
    view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_RETURNING, true);
    view.setInt32(buf + JMP_BUF_OFFSET_VALUE, value, true);
    
    // It would be really cool if there was a way to just unwind without doing any of the saving.
    // But after staring at https://github.com/WebAssembly/binaryen/blob/main/src/passes/Asyncify.cpp
    // for way too long trying to make asyncify_start_unwind() not save the locals if the provided
    // jmp_buf was null I gave up. So for now our runtime has to allocate another 4096 bytes to make
    // this work. If you or a loved one could figure this out, I would be very happy.
    // -nzizic, 1 July 2025
    jmp_buf_init(jmp_buf_for_garbage);
    jai_exports.asyncify_start_unwind(jmp_buf_for_garbage);
    active_jmp_buf = jmp_buf;
};



/*

@Volatile has to match definitions in Toolchains/Web/module.jai

TODO: document this crazyness more fully
setjmp/logjmp implementation
used by libc and our wasm_pause/wasm_resume

ASYNC_BUF_SIZE :: 4096;

jmp_buf_header :: struct {
    top: *void;
    end: *void;
    unwound: *void;
    state: s32;
    value: s32;
};

jmp_buf :: struct {
    using header: jmp_buf_header;
    buffer: [ASYNC_BUF_SIZE - sizeof(jmp_buf_header)]u8;
};

*/

const JMP_BUF_SIZE = 4096n;

const JMP_BUF_STATE_INITIALIZED = 0;
const JMP_BUF_STATE_CAPTURING   = 1;
const JMP_BUF_STATE_CAPTURED    = 2;
const JMP_BUF_STATE_RETURNING   = 3;
const JMP_BUF_STATE_PAUSING    = 4;

const JMP_BUF_OFFSET_TOP     = 0;
const JMP_BUF_OFFSET_END     = 8;
const JMP_BUF_OFFSET_UNWOUND = 16;
const JMP_BUF_OFFSET_STATE   = 24;
const JMP_BUF_OFFSET_VALUE   = 28;
const JMP_BUF_OFFSET_PAYLOAD = 32;

const jmp_buf_log_header = (_jmp_buf) => {
    const jmp_buf = Number(_jmp_buf);
    const view = new DataView(jai_exports.memory.buffer);
    console.log(`jmp_buf: 0x${jmp_buf.toString(16)}
    top: 0x${view.getBigInt64(jmp_buf + JMP_BUF_OFFSET_TOP, true).toString(16)}
    end: 0x${view.getBigInt64(jmp_buf + JMP_BUF_OFFSET_END, true).toString(16)}
    unwound: 0x${view.getBigInt64(jmp_buf + JMP_BUF_OFFSET_UNWOUND, true).toString(16)}
    state: ${view.getInt32(jmp_buf + JMP_BUF_OFFSET_STATE, true)}
    value: ${view.getInt32(jmp_buf + JMP_BUF_OFFSET_VALUE, true)}
    `);
};

const jmp_buf_init = (jmp_buf) => {
    const view = new DataView(jai_exports.memory.buffer);
    const buf  = Number(jmp_buf);
    view.setBigInt64(buf + JMP_BUF_OFFSET_TOP, BigInt(buf + JMP_BUF_OFFSET_PAYLOAD), true);
    view.setBigInt64(buf + JMP_BUF_OFFSET_END, jmp_buf + JMP_BUF_SIZE, true);
    view.setBigInt64(buf + JMP_BUF_OFFSET_UNWOUND, 0n, true);
};

// wasm_prepare_rewind returns true if active_jmp_buf was unwound with
// the intention of being rewound immediately (setjmp was called)
// and returns false if active_jmp_buf was unwound with the intent
// of being rewound at a later point (wasm_pause was called).
const wasm_prepare_for_rewind = () => {
    const view  = new DataView(jai_exports.memory.buffer);
    const buf   = Number(active_jmp_buf);
    const state = view.getInt32(buf + JMP_BUF_OFFSET_STATE, true);
    const value = view.getInt32(buf + JMP_BUF_OFFSET_VALUE, true);
    
    switch (state) {
    case JMP_BUF_STATE_PAUSING: {
        active_jmp_buf = 0n;
        return false;
    }
    case JMP_BUF_STATE_CAPTURING: {
        view.setBigInt64(
            buf + JMP_BUF_OFFSET_UNWOUND,
            view.getBigInt64(buf + JMP_BUF_OFFSET_TOP, true),
            true
        );
    } break;
    case JMP_BUF_STATE_CAPTURED:
    case JMP_BUF_STATE_RETURNING: {
        view.setBigInt64(
            buf + JMP_BUF_OFFSET_TOP,
            view.getBigInt64(buf + JMP_BUF_OFFSET_UNWOUND, true),
            true
        );
    } break;
    default: {
        jmp_buf_log_header(active_jmp_buf);
        throw Error(`unreachable active_jmp_buf state ${state}`);
    }
    }
    
    return true;
};


const wasm_pause = () => {
    const value = jai_imports.js_setjmp(jmp_buf_for_pausing);
    const view  = new DataView(jai_exports.memory.buffer);
    const buf   = Number(jmp_buf_for_pausing);
    const state = view.getInt32(buf + JMP_BUF_OFFSET_STATE, true);
    
    switch (state) {
    case JMP_BUF_STATE_CAPTURING : view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_PAUSING,     true); break;
    case JMP_BUF_STATE_CAPTURED  : view.setInt32(buf + JMP_BUF_OFFSET_STATE, JMP_BUF_STATE_INITIALIZED, true); break;
    }
    return value;
};

// TODO: try compiling a to a library with a different js header that does a Proxy thing that sets entry_point
const wasm_resume = (value) => {
    jai_imports.js_longjmp(jmp_buf_for_pausing, value);
    active_jmp_buf = 0n;
    jai_exports.asyncify_start_rewind(jmp_buf_for_pausing);
    entry_point();
};

// We have to do this because you cannot call context.logger (or any wasm procedure)
// While in a suspended state. So use set_resume_error at the moment the error happens
// and log_resume_error when resuming execution, See File.js for examples
let resume_error_message = "";
const set_resume_error = (message) => { resume_error_message = message;      }
const log_resume_error = ()        => { jai_log_error(resume_error_message); }





// TODO: document OPFS and why it has to be in Runtime_Support


const opfs_get_absolute_path = (path) => {
    if (path.startsWith("/"))
        return path;
    else 
        return opfs_current_working_directory.full_path + path;
};

// returns a opfs handle or undefined if it could not be found
const opfs_absolute_path_to_parent_and_name = async (absolute, create_parents) => {
    if (navigator.storage) {
        const root    = await navigator.storage.getDirectory();
        const folders = [];
        const parts   = absolute.split('/').filter(part => part);
        
        for (let it_index = 0; it_index <= parts.length-2; it_index++) {
            const it = parts[it_index];
            if (it === ".") {
                continue;
            } else if (it === "..") {
                folders.pop();
                continue;
            } else {
                const parent = folders[folders.length-1] ?? root;
                try {
                    const next = await parent.getDirectoryHandle(it, { create: create_parents });
                    folders.push(next);
                } catch (e) {
                    if (e.name !== "NotFoundError") throw e; // uggg
                    return {
                        ok: false,
                        parent: undefined,
                        file_name: undefined,
                    };
                }
            }
        }
        
        return {
            ok: true,
            parent: folders.pop() ?? root,
            file_name: parts[parts.length-1],
        }
    }
    else {
        return {
            ok: false
        }
    }
    
};

// takes a path to a directory and makes sure all of the folders exist to make it a path to a valid folder
const opfs_ensure_path_exists = async (path, is_directory) => {
    const absolute = opfs_get_absolute_path(path);
    const { ok, parent, file_name } = await opfs_absolute_path_to_parent_and_name(absolute, true);
    if (!ok) {
        return 
        // throw new Error("unreachable");
    }
    
    let handle;
    if (is_directory) {
        handle = await parent.getDirectoryHandle(file_name, { create: true });
    } else {
        handle = await parent.getFileHandle(file_name, { create: true });
    }
    
    handle.full_path = absolute; // we stick in on here because it is usefulP
    
    return handle;
};

const opfs_find_file = async (path, create = false) => {
    try {
        const absolute = opfs_get_absolute_path(path);
        const { ok, parent, file_name } = await opfs_absolute_path_to_parent_and_name(absolute, false);
        if (!ok) return undefined;
        
        const handle = await parent.getFileHandle(file_name, { create: create });
        handle.full_path = absolute; // we stick in on here because it is useful
        
        return handle;
    } catch (e) {
        if (e.name !== "NotFoundError") throw e; // we still want to crash if we get some other error
        return undefined;
    }
};

const opfs_find_directory = async (path, create = false) => {
    try {
        const absolute = opfs_get_absolute_path(path);
        const { ok, parent, file_name } = await opfs_absolute_path_to_parent_and_name(absolute, false);
        if (!ok) return undefined;
        
        const handle = await parent.getDirectoryHandle(file_name, { create: create });
        handle.full_path = absolute; // we stick in on here because it is useful
        
        return handle;
    } catch (e) {
        if (e.name !== "NotFoundError") throw e; // we still want to crash if we get some other error
        return undefined;
    }
};


/*

Helper functions used by the runtime

*/

// If you run a jai program "to completion" (i.e. you call a procedure and it returns normally)
// context.stack_trace is still set to a pointer on the stack. So if you want to restart from another
// procedure you have to clear this to null yourself. You do not have to do this if you are calling jai
// code from within a js import procedure.
// :WasmNullStackTrace
const null_context_stack_trace = () => {
    const view = new DataView(jai_exports.memory.buffer);
    const context_stack_trace_offset  = 72; // @Volatile
    const context_stack_trace_address = Number(jai_context) + context_stack_trace_offset;
    view.setBigInt64(context_stack_trace_address, 0n, true);
};

const find_mangled_jai_procedure = (name) => {
    const re = new RegExp('^'+name+'_[0-9a-z]+$');
    for (let full_name in jai_exports) if (re.test(full_name)) return jai_exports[full_name];
    throw `Could not find ${name} in the wasm module!`;
}
    
// TODO: expose a proper jai_log_* that use get_caller_location() and jai_exports.jai_log()
const jai_log_error = (message) => {
    const encoder = text_encoder ?? new TextEncoder();
    const source  = encoder.encode(message);
    const count   = BigInt(source.length);
    const data    = jai_exports.temporary_alloc(jai_context, count);
    new Uint8Array(jai_exports.memory.buffer, Number(data), source.length).set(source);
    jai_exports.context_log(jai_context, data, count);
};

const get_caller_location = () => {
    const lines = new Error().stack.split("\n");
    const location     = lines[3].split("at ")[1];
    const start_column = location.lastIndexOf(":");
    const start_line   = location.lastIndexOf(":", start_column-1);
    return {
        file   : location.substring(0, start_line),
        line   : Number(location.substring(start_line+1, start_column)),
        column : Number(location.substring(start_column+1)),
    };
}


// Since passing strings to and from wasm land sucks big time and 
// a lot of time we are just passing constants, we are going to maintain
// a cache of constants that we copy over so that we do not copy every frame
const constant_string_table = new Map();

const text_decoder = new TextDecoder();
const copy_string_to_js = (count, data, is_constant) => {
    if (!is_constant) {
        const u8 = new Uint8Array(jai_exports.memory.buffer)
        const bytes = u8.subarray(Number(data), Number(data) + Number(count));
        const result = text_decoder.decode(bytes);
        // console.log(`normal decode "${result}"`);
        return result;
    }
    
    const key = (count << 64n) | data;
    const str = constant_string_table.get(key);
    if (str !== undefined) {
        // console.log(`cached decdode "${str}"!`);
        return str;
    }
    
    const u8 = new Uint8Array(jai_exports.memory.buffer)
    const bytes = u8.subarray(Number(data), Number(data) + Number(count));
    const result = text_decoder.decode(bytes);
    constant_string_table.set(key, result);
    // console.log(`caching decode "${result}"`);
    return result;  
};

const text_encoder = new TextEncoder();
const copy_string_from_js = (jai_string_pointer, js_string) => {
    const source = text_encoder.encode(js_string);
    const count  = BigInt(source.length);
    const data   = jai_exports.context_alloc(jai_context, count); // should we expose this with other allocators or should the user just copy this if they need to?
    
    const view = new DataView(jai_exports.memory.buffer);
    const base = Number(jai_string_pointer);
    view.setBigInt64(base + 0, count, true);
    view.setBigInt64(base + 8, data, true);
    
    const destination = new Uint8Array(jai_exports.memory.buffer, Number(data), Number(count));
    destination.set(source);
}

// console.log and console.error always add newlines so we need to buffer the output from write_string
// to simulate a more basic I/O behavior. We’ll flush it after a certain time so that you still
// see the last line if you forget to terminate it with a newline for some reason.
let console_buffer = "";
let console_buffer_is_standard_error;
let console_timeout;
const FLUSH_CONSOLE_AFTER_MS = 3;
const flush_console_buffer = () => {
    if (!console_buffer) return;

    if (console_buffer_is_standard_error) {
        console.error(console_buffer);
    } else {
        console.log(console_buffer);
    }

    console_buffer = "";
};

const write_to_console_log = (str, to_standard_error) => {
    if (console_buffer && console_buffer_is_standard_error != to_standard_error) {
        flush_console_buffer();
    }

    console_buffer_is_standard_error = to_standard_error;
    const lines = str.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
        console_buffer += lines[i];
        flush_console_buffer();
    }

    console_buffer += lines[lines.length - 1];

    clearTimeout(console_timeout);
    if (console_buffer) {
        console_timeout = setTimeout(() => { flush_console_buffer(); }, FLUSH_CONSOLE_AFTER_MS);
    }
}

jai_imports.js_get_web_message_received = (data, count, recv_ptr) => {
    const dest = new Uint8Array(jai_exports.memory.buffer, Number(data), Number(count));

    dest.set(web_buffer);

    // Interpret recv_ptr as a s64 pointer to jai_exports.memory
    const view = new DataView(jai_exports.memory.buffer);
    const recv_address = Number(recv_ptr);

    view.setBigInt64(recv_address, BigInt(web_buffer_cursor), true);

    web_buffer_cursor = 0;
};


/*

Module WebGL platform layer inserted from C:/Users/Tackwin/Documents/Code/jai/modules/Toolchains/Web/libjs/WebGL.js

*/

let front_canvas = undefined;
const back_canvas = new OffscreenCanvas(0, 0);
const gl = back_canvas.getContext("webgl2");
if (!gl ||
    !gl.getExtension("EXT_texture_filter_anisotropic")
) throw new Error("Browser does not support WebGL!");

const gl_handles = []; // this stores both shader components and programs
const gl_obj2id = (obj) => {
    gl_handles.push(obj);
    return gl_handles.length;
};
const gl_id2obj = (handle) => {
    // since gl procedures use an ID of 0 as a sentinel that webgl uses null for
    if (handle === 0) return null;
    const index = handle - 1;
    const obj   = gl_handles[index];
    if (!obj) throw new Error(`Handle ${handle} does not refer to a valid opengl object`);
    return obj;
};


jai_imports.js_gl_set_render_target = (window_id) => {
    front_canvas = get_canvas(window_id);
    back_canvas.width  = front_canvas.width;
    back_canvas.height = front_canvas.height;
};

jai_imports.js_webgl_swap_buffers = (window, vsync) => {
    if (wasm_pause() === 0) {
        const render_and_resume = () => {
            jai_imports.js_gl_set_render_target(window);
            front_canvas.getContext("2d").drawImage(back_canvas, 0, 0, front_canvas.width, front_canvas.height);
            wasm_resume(1);
        };
        
        if (vsync) requestAnimationFrame(render_and_resume);
        else       setTimeout(render_and_resume, 0);
    }
};

jai_imports.glReadBuffer = (src) => { gl.readBuffer(src); };
jai_imports.glViewport = (x, y, width, height) => { gl.viewport(x, y, width, height); };
jai_imports.glScissor = (x, y, width, height) => { gl.scissor(x, y, width, height); };
jai_imports.glCreateProgram = () => { return gl_obj2id(gl.createProgram()); };
jai_imports.glCreateShader = (typ) => { return gl_obj2id(gl.createShader(typ)); };
jai_imports.glAttachShader = (program, shader) => { gl.attachShader(gl_id2obj(program), gl_id2obj(shader)); };
jai_imports.glLinkProgram = (program) => { gl.linkProgram(gl_id2obj(program)); };
jai_imports.glDeleteShader = (shader) => { gl.deleteShader(gl_id2obj(shader)); };
jai_imports.glBindTexture = (target, texture) => { gl.bindTexture(target, gl_id2obj(texture)); };
jai_imports.glClearColor = (r, g, b, a) => { gl.clearColor(r, g, b, a); };
jai_imports.glClear = (mask) => { gl.clear(mask); };
jai_imports.glDepthMask = (flag) => { gl.depthMask(flag); };
jai_imports.glEnable = (cap) => { gl.enable(cap); };
jai_imports.glDisable = (cap) => { gl.disable(cap); };
jai_imports.glUseProgram = (program) => { gl.useProgram(gl_id2obj(program)); };
jai_imports.glUniformBlockBinding = (program, index, binding) => { gl.uniformBlockBinding(gl_id2obj(program), index, binding); };
jai_imports.glUniform1i = (loc, v) => { gl.uniform1i(gl_id2obj(loc), v); };
jai_imports.glUniform2f = (loc, x, y) => { gl.uniform2f(gl_id2obj(loc), x, y); };
jai_imports.glUniform3f = (loc, x, y, z) => { gl.uniform3f(gl_id2obj(loc), x, y, z); };
jai_imports.glEnableVertexAttribArray = (index) => { gl.enableVertexAttribArray(index); };
jai_imports.glVertexAttribPointer = (index, size, typ, norm, stride, p) => { gl.vertexAttribPointer(index, size, typ, norm, stride, Number(p)); };
jai_imports.glVertexAttribDivisor = (index, divisor) => { gl.vertexAttribDivisor(index, divisor); };
jai_imports.glVertexAttribIPointer = (index, size, typ, stride, offset) => { gl.vertexAttribIPointer(index, size, typ, stride, Number(offset)); };
jai_imports.glDrawArrays = (mode, first, count) => { gl.drawArrays(mode, first, count); };
jai_imports.glDrawArraysInstanced = (mode, first, count, n) => { gl.drawArraysInstanced(mode, first, count, n); };
jai_imports.glDrawElements = (mode, count, typ, offset) => { gl.drawElementsInstanced(mode, count, typ, Number(offset), 1); };
jai_imports.glTexParameteri = (target, pname, param) => { gl.texParameteri(target, pname, param); };
jai_imports.glTexParameterf = (target, pname, param) => { gl.texParameterf(target, pname, param); };
jai_imports.glPixelStorei = (pname, param) => { gl.pixelStorei(pname, param); };
jai_imports.glActiveTexture = (texture) => { gl.activeTexture(texture); };
jai_imports.glBlendFunc = (s,d) => { gl.blendFunc(s, d); };
jai_imports.glFlush = () => { gl.flush(); };
jai_imports.glCompileShader = (shader) => { gl.compileShader(gl_id2obj(shader)); };
jai_imports.glGetIntegerv   = (pname, data) => { new DataView(jai_exports.memory.buffer).setInt32(Number(data), gl.getParameter(pname), true); };
jai_imports.glGetShaderiv   = (shader, pname, out_param) => { new DataView(jai_exports.memory.buffer).setInt32(Number(out_param), gl.getShaderParameter(gl_id2obj(shader), pname), true); };
jai_imports.glGetProgramiv  = (shader, pname, out_param) => { new DataView(jai_exports.memory.buffer).setInt32(Number(out_param), gl.getProgramParameter(gl_id2obj(shader), pname), true); };

jai_imports.glGetAttribLocation = (program, name_count, name_data, name_is_constant) => {
    const prog = gl_id2obj(program);
    const name = copy_string_to_js(name_count, name_data, name_is_constant);
    const result = gl.getAttribLocation(prog, name);
    return result;
};

jai_imports.glGetUniformLocation = (program, name_count, name_data, name_is_constant) => {
    const prog   = gl_id2obj(program);
    const name   = copy_string_to_js(name_count, name_data, name_is_constant);
    const loc    = gl.getUniformLocation(prog, name);
    const result = gl_obj2id(loc);
    return result;
};

jai_imports.glBindFramebuffer = (target, buffer) => { gl.bindFramebuffer(target, gl_id2obj(buffer)); };
jai_imports.glBindVertexArray = (array) => { gl.bindVertexArray(gl_id2obj(array)); };
jai_imports.glBindBuffer = (target, buffer) => { gl.bindBuffer(target, gl_id2obj(buffer)); };
jai_imports.glBindBufferBase = (target, index, buffer) => { gl.bindBufferBase(target, index, gl_id2obj(buffer)); };
jai_imports.glBufferData = (target, size, data, usage) => { gl.bufferData(target, (data === 0n) ? Number(size) : new DataView(jai_exports.memory.buffer, Number(data), Number(size)), usage); };
jai_imports.glBufferSubData = (target, offset, size, _data) => { gl.bufferSubData(target, Number(offset), new DataView(jai_exports.memory.buffer, Number(_data), Number(size))); };
jai_imports.glGetBufferSubData = (target, offset, size, data) => {
    const memory = new Uint8Array(jai_exports.memory.buffer, Number(data), Number(size));
    gl.getBufferSubData(target, Number(offset), memory);
};

jai_imports.glGenVertexArrays = (n, arrays) => {
    const view = new DataView(jai_exports.memory.buffer);
    for (let i = 0; i < n; i++) {
        const handle = gl_obj2id(gl.createVertexArray());
        view.setUint32(Number(arrays) + i * 4, handle, true);
    }
};

jai_imports.glGenFramebuffers = (n, buffers) => {
    const view = new DataView(jai_exports.memory.buffer);
    for (let i = 0; i < n; i++) {
        const handle = gl_obj2id(gl.createFramebuffer());
        view.setUint32(Number(buffers) + i * 4, handle, true);
    }
};

jai_imports.glGenBuffers = (n, buffers) => {
    const view = new DataView(jai_exports.memory.buffer);
    for (let i = 0; i < n; i++) {
        const handle = gl_obj2id(gl.createBuffer());
        view.setUint32(Number(buffers) + i * 4, handle, true);
    }
};

jai_imports.glDeleteBuffers = (n, buffers) => {
    const view = new DataView(jai_exports.memory.buffer); // TODO: all of these could just create a Uint32Array instead of doing this....
    for (let i = 0; i < n; i++) {
        const handle = view.getUint32(Number(buffers) + i * 4, true);
        const buffer = gl_id2obj(handle);
        gl.deleteBuffer(buffer);
        gl_handles[handle-1] = undefined; // TODO: reuse handles and whatnot
    }
};

jai_imports.glGenTextures = (n, buffers) => {
    const view = new DataView(jai_exports.memory.buffer);
    for (let i = 0; i < n; i++) {
        const handle = gl_obj2id(gl.createTexture());
        view.setUint32(Number(buffers) + i * 4, handle, true);
    }
};

jai_imports.glShaderSource = (_shader, count, strings_data, lengths_data) => {
    const shader = gl_id2obj(_shader);
    const view = new DataView(jai_exports.memory.buffer);
    
    let source = "";
    for (let i = 0; i < count; i++) {
        const count  = view.getInt32(Number(lengths_data) + i * 4, true);
        const data   = view.getBigInt64(Number(strings_data) + i * 8, true);
        
        // Technically it is very likely that this string is actually constant, but in order to 
        // know that for sure we would have to pass an array of is_constants (which we still might
        // at some point). We do not do this right now because we would only load constant shaders
        // once in a real program. Right?
        source += copy_string_to_js(count, data, false) + "\n";
    }
    gl.shaderSource(shader, source);
};


jai_imports.glGetShaderInfoLog = (_shader, length_ptr, data_ptr) => {
    const shader = gl_id2obj(_shader);
    const info = gl.getShaderInfoLog(shader);
    // throw `TODO: copy string and print \n\n${info}`;
};



jai_imports.glGetUniformBlockIndex = (program, name_count, name_data, name_is_constant) => {
    const prog = gl_id2obj(program);
    const name = copy_string_to_js(name_count, name_data, name_is_constant);
    const [ index ] = gl.getUniformIndices(prog, [ name ]);
    return index;
};

jai_imports.glUniformMatrix4fv = (_location, count, transpose, value_ptr) => {
    if (count !== 1) throw "TODO: handle packed array of matrices";
    gl.uniformMatrix4fv(gl_id2obj(_location), transpose, new Float32Array(jai_exports.memory.buffer, Number(value_ptr), 16));
};

jai_imports.glTexImage2D = (target, level, internal_format, width, height, border, format, typ, pixels) => {
    const components   = gl_get_components_from_format(internal_format);
    const element_size = gl_get_size_from_type(typ);
    const data = new Uint8Array(jai_exports.memory.buffer, Number(pixels), width*height*components*element_size);
    gl.texImage2D(target, level, internal_format, width, height, border, format, typ, data);
};

jai_imports.glReadPixels = (x, y, width, height, format, type, offset) => {
    // TODO: i guess we have to check if PI
    if (offset !== 0n) throw "TODO: we can currently only read from the base of the pixel pack buffer sorry!";
    gl.readPixels(x, y, width, height, format, type, Number(offset));
}

// switch 
// case gl.ALPHA: throw "unhandled type ALPHA"
// case gl.RGB: throw "unhandled type RGB"
// case gl.RGBA: throw "unhandled type RGBA"
// case gl.RED: throw "unhandled type RED"
// case gl.RG: throw "unhandled type RG"
// case gl.RED_INTEGER: throw "unhandled type RED_INTEGER"
// case gl.RG_INTEGER: throw "unhandled type RG_INTEGER"
// case gl.RGB_INTEGER: throw "unhandled type RGB_INTEGER"
// case gl.RGBA_INTEGER: throw "unhandled type RGBA_INTEGER"

const gl_get_components_from_format = (format) => {
    switch (format) {
    case gl.RGB8:  return 3;
    case gl.RGBA8: return 4;
    default: throw `TODO: Unsupported texture glformat ${format}`
    }
};

const gl_get_size_from_type = (type) => {
    switch (type) {
    case gl.UNSIGNED_BYTE: return 1;
    default: throw `TODO: Unsupported gl element type ${type}`;
    }
};



/*

Module Input platform layer inserted from C:/Users/Tackwin/Documents/Code/jai/modules/Toolchains/Web/libjs/Input.js

*/

// One important thing to note about working with event listeners with this webassembly stuff:
// DO NOT CALL anything from jai_exports from eventListeners! If an even listener is firing that means
// that the wasm execution is suspended and calling procedures does NOTHING. I'm sure there is a way to
// have a runtime check for this with another proxy object and checking the state of the jmp_buf_for_pausing
// so that a nice error could be thrown, but I really do not want to do that so just be careful ok!
// -nzizic, 2 May 2025

// This is an array of arrays where each element consists of a wasm procedure followed by it's arguments.
// We call the procedures that populate the Input structures during update_window_events
const staged_events = [];

const js_mouse_event_to_jai_keycode = (e) => {
    switch (e.button) {
    case 0: return 168;
    case 1: return 169;
    case 2: return 170;
    default:
        console.warn("Missing mapping for mouse event : ", e);
        return 0;
    }
};

const js_key_event_to_jai_text_input = (e) => (e.key.length === 1) ? e.key.codePointAt(0) : 0;
const js_key_event_to_jai_keycode = (e) => {
    // @Speed: map?
    switch (e.code) {
    case "Backspace": return 8;
    case "Tab":       return 9;
    case "Enter":     return 13;
    case "Escape":    return 27;
    case "Space":     return 32;
    case "Delete":    return 127;

    case "ArrowUp":    return 128;
    case "ArrowDown":  return 129;
    case "ArrowLeft":  return 130;
    case "ArrowRight": return 131;

    case "PageUp":   return 132;
    case "PageDown": return 133;
    case "Home":     return 134;
    case "End":      return 135;
    case "Insert":   return 136;

    case "Pause":      return 137;
    case "ScrollLock": return 138;

    case "AltLeft":     case "AltRight":     return 139;
    case "ControlLeft": case "ControlRight": return 140;
    case "ShiftLeft":   case "ShiftRight":   return 141;
    case "MetaLeft":    case "MetaRight":    return 142;

    case "F1":  return 143;
    case "F2":  return 144;
    case "F3":  return 145;
    case "F4":  return 146;
    case "F5":  return 147;
    case "F6":  return 148;
    case "F7":  return 149;
    case "F8":  return 150;
    case "F9":  return 151;
    case "F10": return 152;
    case "F11": return 153;
    case "F12": return 154;

    default:
        const c = e.key;
        if (c.length === 1) return c.toUpperCase().charCodeAt(0); // A-Z, 0-9, symbols

        console.warn("No mapping for key event: ", e);
        return 0;
    }
};




document.addEventListener('dragover', (event) => {
    if (jai_exports === undefined) return;
    event.preventDefault();
});

document.addEventListener('drop', async (event) => {
    if (jai_exports === undefined) return;
    event.preventDefault();

    const files = event.dataTransfer.files;
    if (files.length > 0) {
        const base    = OPFS_COPIED_FILES_PATH + Date.now().toString() + "_";
        const to_send = [];
        
        for (let index = 0; index < files.length; index++) {
            const it     = files[index];
            const path   = base + it.name;
            const handle = await opfs_ensure_path_exists(path, false);
            const writer = await handle.createWritable();
            await writer.write(it);
            await writer.close();
            to_send.push(path);
        }
        staged_events.push([
            send_dropped_files_to_input_module,
            to_send,
        ]);
    }
});

const send_dropped_files_to_input_module = (jai_context, files) => {
    const current_file = jai_exports.temporary_alloc(jai_context, 16n); // allocating a string makes things a bit nicer here
    for (let it_index = 0; it_index < files.length; it_index++) {
        const it   = files[it_index];
        copy_string_from_js(current_file, it);
        jai_exports.add_dropped_file(jai_context, current_file);
    }
    jai_exports.send_dropped_files(jai_context);
}



// keyboard


document.addEventListener("keydown", (event) => {
    if (jai_exports === undefined) return;
    
    const is_dev_tools_key = 
        event.key === "F12" || 
        (event.ctrlKey && event.shiftKey && event.key === "I") || 
        (event.metaKey && event.altKey && event.key === "I");
    if (!is_dev_tools_key) event.preventDefault();
    
    const key  = js_key_event_to_jai_keycode(event);
    const text = js_key_event_to_jai_text_input(event);
    staged_events.push([
        jai_exports.add_key_event,
        key, text, true,
        event.repeat, event.altKey, event.shiftKey, event.ctrlKey, event.metaKey,
    ]);
    // const [code, is_text] = jai_keycode_from_js_event(event);
    // staged_events.push([
    //     jai_exports.add_key_event,
    //     code,
    //     true,
    // ]);
    // if (is_text) staged_events.push([ jai_exports.add_text_input_event, code ]);
});

document.addEventListener("keyup", (event) => {
    if (jai_exports === undefined) return;
    
    const is_dev_tools_key = 
        event.key === "F12" || 
        (event.ctrlKey && event.shiftKey && event.key === "I") || 
        (event.metaKey && event.altKey && event.key === "I");
    if (!is_dev_tools_key) event.preventDefault();
    
    const key  = js_key_event_to_jai_keycode(event);
    const text = js_key_event_to_jai_text_input(event);
    staged_events.push([
        jai_exports.add_key_event,
        key, text, false,
        event.repeat, event.altKey, event.shiftKey, event.ctrlKey, event.metaKey,
    ]);
});



// mouse

let mouse_position_x = 0;
let mouse_position_y = 0;
document.addEventListener("mousemove", (event) => {
    if (jai_exports === undefined) return;
    const scale = Math.ceil(window.devicePixelRatio);
    mouse_position_x = event.clientX;
    mouse_position_y = event.clientY;
});

document.addEventListener("pointerdown", (event) => {
    if (jai_exports === undefined) return;
    const code = js_mouse_event_to_jai_keycode(event);
    staged_events.push([
        jai_exports.add_key_event,
        code, 0, true,
        event.repeat, event.altKey, event.shiftKey, event.ctrlKey, event.metaKey,
    ]);
});

document.addEventListener("pointerup", (event) => {
    if (jai_exports === undefined) return;
    const code = js_mouse_event_to_jai_keycode(event);
    staged_events.push([
        jai_exports.add_key_event,
        code, 0, false,
        event.repeat, event.altKey, event.shiftKey, event.ctrlKey, event.metaKey,
    ]);
});

// window resize
const fullscreen_canvas_resize_listener = (window_id) => () => {
    const canvas  = get_canvas(window_id);
    const scale   = Math.ceil(window.devicePixelRatio);
    canvas.width  = window.innerWidth  * scale;
    canvas.height = window.innerHeight * scale;
    canvas.style.width  = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    // canvas.getContext("2d").setTransform(scale, 0, 0, scale, 0, 0);
    // console.log("pixel ratio is ", scale);
    staged_events.push([
        jai_exports.add_window_resize,
        window_id,
        canvas.width,
        canvas.height,
    ])
};



// touch
const last_touches = [];
jai_imports.js_device_supports_touch_input = () => { return 'ontouchstart' in document.documentElement; };

// Used by Window_Creation.get_mouse_pointer_position when we emulate, I do not like this module crossing stuff, but it looks like that is something specific to the Input module...
let primary_touch_x = undefined;
let primary_touch_y = undefined;

document.addEventListener("touchstart", (event) => {
    if (jai_exports === undefined) return;
    event.preventDefault();
    
    last_touches.length = 0;
    last_touches.push(...event.targetTouches);
    const scale = Math.ceil(window.devicePixelRatio);
    for (let it_index = 0; it_index < event.targetTouches.length; it_index++) {
        const it = event.targetTouches[it_index];
        
        staged_events.push([
            jai_exports.add_touch,
            it.identifier,
            1,
            it.pageX * scale,
            it.pageY * scale,
        ]);
        
        // get_mouse_pointer_position does dpi scalling so pass the raw values here
        if (it_index === 0) {
            primary_touch_x = it.pageX;
            primary_touch_y = it.pageY;
        }
    }
}, { passive: false });

document.addEventListener("touchmove", (event) => {
    if (jai_exports === undefined) return;
    event.preventDefault();
    
    const scale = Math.ceil(window.devicePixelRatio);
    for (let it_index = 0; it_index < event.targetTouches.length; it_index++) {
        const it = event.targetTouches[it_index];
        
        staged_events.push([
            jai_exports.add_touch,
            it.identifier,
            0,
            it.pageX * scale,
            it.pageY * scale,
        ]);
        
        // get_mouse_pointer_position does dpi scalling so pass the raw values here
        if (it_index === 0) {
            primary_touch_x = it.pageX;
            primary_touch_y = it.pageY;
        }
    }
}, { passive: false });


const touch_end = (event) => {
    if (jai_exports === undefined) return;
    event.preventDefault();
    
    const scale = Math.ceil(window.devicePixelRatio);
    const held_touches = new Set(Array.from(event.targetTouches).map(x => x.identifier));
    
    for (let last_touch_index = last_touches.length - 1; last_touch_index >= 0; last_touch_index--) {
        const last_touch = last_touches[last_touch_index];
        if (!held_touches.has(last_touch.identifier)) {
            staged_events.push([
                jai_exports.add_touch,
                last_touch.identifier,
                2,
                last_touch.pageX * scale,
                last_touch.pageY * scale,
            ]);
            last_touches.splice(last_touch_index, 1);
        }
    }
    
    // Reset primary touch coordinates when all touches end
    if (event.targetTouches.length === 0) {
        primary_touch_x = undefined;
        primary_touch_y = undefined;
    }
};

document.addEventListener("touchend", touch_end, { passive: false });
document.addEventListener("touchcancel", touch_end, { passive: false });



// update 
let mouse_position_x_last_frame = 0;
let mouse_position_y_last_frame = 0;
jai_imports.js_update_window_events = () => {
    const mouse_delta_x = mouse_position_x - mouse_position_x_last_frame;
    const mouse_delta_y = mouse_position_y - mouse_position_y_last_frame;
    mouse_position_x_last_frame = mouse_position_x;
    mouse_position_y_last_frame = mouse_position_y;
    jai_exports.set_mouse_delta(mouse_delta_x, mouse_delta_y, 0);
    
    // This is so silly, but the nicest way to factor things given the constraints...
    for (let it_index = 0; it_index < staged_events.length; it_index++) {
        const [proc, ...args] = staged_events[it_index];
        proc(jai_context, ...args);
    }
    staged_events.length = 0;
};


/*

Module Window_Creation platform layer inserted from C:/Users/Tackwin/Documents/Code/jai/modules/Toolchains/Web/libjs/Window_Creation.js

*/

const canvases = [];
const get_canvas = (window) => {
    const canvas = canvases[window];
    if (!canvas) throw `Window id ${window} is not valid`;
    return canvas;
}

jai_imports.js_create_window = (width, height, name_count, name_data, name_is_constant, window_x, window_y, parent, bg_color_ptr, wanted_msaa) => {
    const name = copy_string_to_js(name_count, name_data, name_is_constant);
    const view = new DataView(jai_exports.memory.buffer);
    
    const offset  = Number(bg_color_ptr);
    const color_r = view.getFloat32(offset + 0, true);
    const color_g = view.getFloat32(offset + 4, true);
    const color_b = view.getFloat32(offset + 8, true);
    
    
    const canvas  = document.createElement('canvas');
    canvas.id     = name;
    canvas.width  = Math.floor(0.5 + Number(width));
    canvas.height = Math.floor(0.5 + Number(height));
    canvas.style.backgroundColor = `rgba(${color_r * 255}, ${color_g * 255}, ${color_b * 255}, 1)`;
    canvas.style.position = "absolute";
    canvas.style.margin   = "0";
    canvas.style.left     = `${(window_x === -1n) ? 0 : window_x}px`;
    canvas.style.top      = `${(window_y === -1n) ? 0 : window_y}px`;
    
    if (parent !== -1n) throw new Error("TODO: What does that even mean in this context?");
    
    document.body.appendChild(canvas);
    canvases.push(canvas);
    const window_id = BigInt(canvases.length - 1);
    
    // This might be too much voodoo, or maybe just a good idea:
    
    // A lot of the example programs hard code the resolution to be bigger than your typical browser window can display at once.
    // This should be allowed since it is the equivalent of creating a window that is larger than your screen resolution, which is 
    // a valid thing to do in every operating system (why someone would do this is another question entirely...).
    // At the same time, there is a convention in the Window_Creation API that -1 for window position means to place it wherever.
    
    // We will extend that concept to mean that if you do not specify an initial window position, the created canvas will be mapped
    // to the entire browser window and we will forward window resizes to the Input module.
    
    // This is the best compromise I could think of that makes most programs behave how you would expect, with the one caveat
    // that you MUST explicitly position every window if your application has multiple windows.
    
    // An alterantive solution would be to implement a proper window manager in HTML/CSS/JS so that the user can resize the canvas like
    // they can in other OSes, which would be pretty cool thing to try and implement
    
    // The one edge case I can think of here is a situation where you are using Simp but not Input, and in that case you can call
    // Simp.get_render_dimensions explicitly anyway
    
    // -nzizic, 2 May 2025
    
    if (window_x === -1n && window_y === -1n) {
        canvas.style.width  = "100%";
        canvas.style.height = "100%";
        if (typeof fullscreen_canvas_resize_listener !== "undefined") {
            const listen = fullscreen_canvas_resize_listener(window_id);
            window.addEventListener("resize", listen);
            listen();
        } else {
            const scale   = Math.ceil(window.devicePixelRatio);
            canvas.width  = window.innerWidth  * scale;
            canvas.height = window.innerHeight * scale;
            // canvas.style.width  = `${window.innerWidth}px`;
            // canvas.style.height = `${window.innerHeight}px`;
        }
    }
    
    return window_id;
};

jai_imports.js_get_mouse_pointer_position = (window_id, right_handed, out_x, out_y) => {
    if ((mouse_position_x == undefined) || (mouse_position_y == undefined)) {
        jai_log_error(`You need to #import "Input" in order to get mouse information. Sorry!`);
        return false;
    }
    
    let pos_x;
    let pos_y;
    if (window.matchMedia("(pointer: fine)").matches) {
        // This checks if we actually have a mouse plugged in
        pos_x = mouse_position_x;
        pos_y = mouse_position_y;
    } else if (jai_imports.js_device_supports_touch_input()) {
        // if you have no mouse we will treat the primary touch as the pointer if there is one
        if ((primary_touch_x == undefined) || (primary_touch_y == undefined)) {
            // TODO: this isn't really an error, there just isn't a pointer anywhere
            return false;
        }
        pos_x = primary_touch_x;
        pos_y = primary_touch_y;
    } else {
        jai_log_error("Tried to get_mouse_pointer_position on a device that has no mouse and no touch input. What are you doing?");
        return false;
    }
    
    const canvas = get_canvas(window_id);
    const rect = canvas.getBoundingClientRect();
    
    const scale = Math.ceil(window.devicePixelRatio);
    const x = BigInt(Math.floor(scale * (0.5 + pos_x - rect.left)));
    const y = (right_handed !== 0)
        ? BigInt(Math.floor(scale * (0.5 + rect.bottom - (window.innerHeight * (pos_y / window.innerHeight)))))
        : BigInt(Math.floor(scale * (0.5 + pos_y - rect.top)));
    
    const view  = new DataView(jai_exports.memory.buffer);
    view.setBigInt64(Number(out_x), x, true);
    view.setBigInt64(Number(out_y), y, true);
    
    return true;
};

jai_imports.js_get_render_dimensions = (window, width_ptr, height_ptr) => {
    const canvas = get_canvas(window);
    const view   = new DataView(jai_exports.memory.buffer);
    view.setInt32(Number(width_ptr),  canvas.width, true); // Write width
    view.setInt32(Number(height_ptr), canvas.height, true); // Write height
};

jai_imports.js_get_window_dimensions = (window, right_handed, x_ptr, y_ptr, width_ptr, height_ptr) => {
    // if (right_handed !== 0) throw "TODO wasm_get_dimensions right_handed";
    
    const canvas = get_canvas(window);
    const view   = new DataView(jai_exports.memory.buffer);
    
    // TODO: css absolute position stuff??
    view.setInt32(Number(x_ptr), 0, true);
    view.setInt32(Number(y_ptr), 0, true);
    view.setInt32(Number(width_ptr),  canvas.width, true); // Write width
    view.setInt32(Number(height_ptr), canvas.height, true); // Write height
};

// js_toggle_fullscreen :: (window: Window_Type, desire_fullscreen: bool, width: *s32, height: *s32) -> bool #foreign;
jai_imports.js_toggle_fullscreen = (window, desire_fullscreen, out_width, out_height) => {
    const canvas = get_canvas(window); // TODO: report invalid canvas properly through jai_log_error etc.....
    
    switch (wasm_pause()) {
    case 0: (async () => {
        try {
            if (desire_fullscreen) {
                await canvas.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
            const view = new DataView(jai_exports.memory.buffer);
            view.setInt32(Number(out_width), canvas.width, true);
            view.setInt32(Number(out_height), canvas.height, true);
            wasm_resume(+1);
        } catch (e) {
            set_resume_error(`Could not toggle fullscreen (${e.name}) ${e.message}`);
            wasm_resume(-1);
        }
    })(); return;
    case +1: return true;
    case -1: log_resume_error(); return false;
    }
};