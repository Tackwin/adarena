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
let audio_context = null;

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
	audio_context = new AudioContext();
    
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

jai_imports.js_get_token = () => {
    if (sessionStorage.getItem("token")) {
        return parseInt(sessionStorage.getItem("token"), 10);
    }
    return Math.random() * 1024 * 1024;
}

jai_imports.js_set_token = (token) => {
    sessionStorage.setItem("token", token);
};



//WEBGPU
let object_map = [];
let buffer_to_pointer_map = [];
let object_map_counter = 0;

const WGPUStatus_SUCCESS = 1;
const WGPUStatus_ERROR = 2;

const WGPUStype_ShaderSourceSPIRV = 1;
const WGPUStype_ShaderSourceWGSL = 2;

const WGPUBufferBindingType_Uniform = 2;
const WGPUBufferBindingType_Storage = 3;
const WGPUBufferBindingType_ReadOnlyStorage = 4;

const WGPUVertexStepMode_Vertex = 2;
const WGPUVertexStepMode_Instance = 3;

const WGPUSamplerBindingType_Filtering = 2;
const WGPUSamplerBindingType_NonFiltering = 3;
const WGPUSamplerBindingType_Comparison = 4;

const WGPUAddressMode_ClampToEdge = 1;
const WGPUAddressMode_Repeat = 2;
const WGPUAddressMode_MirrorRepeat = 3;

const WGPUTextureSampleType_Float = 2;
const WGPUTextureSampleType_UnfilterableFloat = 3;
const WGPUTextureSampleType_Depth = 4;
const WGPUTextureSampleType_Sint = 5;
const WGPUTextureSampleType_Uint = 6;

const WGPUStorageTextureAccess_WriteOnly = 2;
const WGPUStorageTextureAccess_ReadOnly = 3;
const WGPUStorageTextureAccess_ReadWrite = 4;

const WGPUCullMode_None = 1;
const WGPUCullMode_Front = 2;
const WGPUCullMode_Back = 3;

const WGPUTextureDimension_1D = 1;
const WGPUTextureDimension_2D = 2;
const WGPUTextureDimension_3D = 3;

const WGPUFrontFace_CCW = 1;
const WGPUFrontFace_CW = 2;

const WGPULoadOp_Undefined = 0;
const WGPULoadOp_Load = 1;
const WGPULoadOp_Clear = 2;

const WGPUStoreOp_Undefined = 0;
const WGPUStoreOp_Store = 1;
const WGPUStoreOp_Discard = 2;

const WGPUMipmapFilterMode_Nearest = 1;
const WGPUMipmapFilterMode_Linear = 2;

const WGPUIndexFormat_Uint16 = 1;
const WGPUIndexFormat_Uint32 = 2;

const WGPUPrimitiveTopology_PointList = 1;
const WGPUPrimitiveTopology_LineList = 2;
const WGPUPrimitiveTopology_LineStrip = 3;
const WGPUPrimitiveTopology_TriangleList = 4;
const WGPUPrimitiveTopology_TriangleStrip = 5;

const WGPUTextureAspect_All = 1;
const WGPUTextureAspect_StencilOnly = 2;
const WGPUTextureAspect_DepthOnly = 3;

const WGPUVertexFormat_Uint8 = 1;
const WGPUVertexFormat_Uint8x2 = 2;
const WGPUVertexFormat_Uint8x4 = 3;
const WGPUVertexFormat_Sint8 = 4;
const WGPUVertexFormat_Sint8x2 = 5;
const WGPUVertexFormat_Sint8x4 = 6;
const WGPUVertexFormat_Unorm8 = 7;
const WGPUVertexFormat_Unorm8x2 = 8;
const WGPUVertexFormat_Unorm8x4 = 9;
const WGPUVertexFormat_Snorm8 = 10;
const WGPUVertexFormat_Snorm8x2 = 11;
const WGPUVertexFormat_Snorm8x4 = 12;
const WGPUVertexFormat_Uint16 = 13;
const WGPUVertexFormat_Uint16x2 = 14;
const WGPUVertexFormat_Uint16x4 = 15;
const WGPUVertexFormat_Sint16 = 16;
const WGPUVertexFormat_Sint16x2 = 17;
const WGPUVertexFormat_Sint16x4 = 18;
const WGPUVertexFormat_Unorm16 = 19;
const WGPUVertexFormat_Unorm16x2 = 20;
const WGPUVertexFormat_Unorm16x4 = 21;
const WGPUVertexFormat_Snorm16 = 22;
const WGPUVertexFormat_Snorm16x2 = 23;
const WGPUVertexFormat_Snorm16x4 = 24;
const WGPUVertexFormat_Float16 = 25;
const WGPUVertexFormat_Float16x2 = 26;
const WGPUVertexFormat_Float16x4 = 27;
const WGPUVertexFormat_Float32 = 28;
const WGPUVertexFormat_Float32x2 = 29;
const WGPUVertexFormat_Float32x3 = 30;
const WGPUVertexFormat_Float32x4 = 31;
const WGPUVertexFormat_Uint32 = 32;
const WGPUVertexFormat_Uint32x2 = 33;
const WGPUVertexFormat_Uint32x3 = 34;
const WGPUVertexFormat_Uint32x4 = 35;
const WGPUVertexFormat_Sint32 = 36;
const WGPUVertexFormat_Sint32x2 = 37;
const WGPUVertexFormat_Sint32x3 = 38;
const WGPUVertexFormat_Sint32x4 = 39;
const WGPUVertexFormat_Unorm10_10_10_2 = 40;
const WGPUVertexFormat_Unorm8x4BGRA = 41;

const WGPUCompareFunction_Never = 1;
const WGPUCompareFunction_Less = 2;
const WGPUCompareFunction_Equal = 3;
const WGPUCompareFunction_LessEqual = 4;
const WGPUCompareFunction_Greater = 5;
const WGPUCompareFunction_NotEqual = 6;
const WGPUCompareFunction_GreaterEqual = 7;
const WGPUCompareFunction_Always = 8;

const WGPUStencilOperation_Keep = 1;
const WGPUStencilOperation_Zero = 2;
const WGPUStencilOperation_Replace = 3;
const WGPUStencilOperation_Invert = 4;
const WGPUStencilOperation_IncrementClamp = 5;
const WGPUStencilOperation_DecrementClamp = 6;
const WGPUStencilOperation_IncrementWrap = 7;
const WGPUStencilOperation_DecrementWrap = 8;

const WGPUBlendOperation_Add = 1;
const WGPUBlendOperation_Subtract = 2;
const WGPUBlendOperation_ReverseSubtract = 3;
const WGPUBlendOperation_Min = 4;
const WGPUBlendOperation_Max = 5;

const WGPUTextureViewDimension_1D = 1;
const WGPUTextureViewDimension_2D = 2;
const WGPUTextureViewDimension_2DArray = 3;
const WGPUTextureViewDimension_Cube = 4;
const WGPUTextureViewDimension_CubeArray = 5;
const WGPUTextureViewDimension_3D = 6;

const WGPUFilterMode_Nearest = 1;
const WGPUFilterMode_Linear = 2;

const WGPUBlendFactor_Zero = 1;
const WGPUBlendFactor_One = 2;
const WGPUBlendFactor_Src = 3;
const WGPUBlendFactor_OneMinusSrc = 4;
const WGPUBlendFactor_SrcAlpha = 5;
const WGPUBlendFactor_OneMinusSrcAlpha = 6;
const WGPUBlendFactor_Dst = 7;
const WGPUBlendFactor_OneMinusDst = 8;
const WGPUBlendFactor_DstAlpha = 9;
const WGPUBlendFactor_OneMinusDstAlpha = 10;
const WGPUBlendFactor_SrcAlphaSaturated = 11;
const WGPUBlendFactor_Constant = 12;
const WGPUBlendFactor_OneMinusConstant = 13;
const WGPUBlendFactor_Src1 = 14;
const WGPUBlendFactor_OneMinusSrc1 = 15;
const WGPUBlendFactor_Src1Alpha = 16;
const WGPUBlendFactor_OneMinusSrc1Alpha = 17;

const WGPUTextureFormat_R8Unorm = 1;
const WGPUTextureFormat_R8Snorm = 2;
const WGPUTextureFormat_R8Uint = 3;
const WGPUTextureFormat_R8Sint = 4;
const WGPUTextureFormat_R16Uint = 5;
const WGPUTextureFormat_R16Sint = 6;
const WGPUTextureFormat_R16Float = 7;
const WGPUTextureFormat_RG8Unorm = 8;
const WGPUTextureFormat_RG8Snorm = 9;
const WGPUTextureFormat_RG8Uint = 10;
const WGPUTextureFormat_RG8Sint = 11;
const WGPUTextureFormat_R32Float = 12;
const WGPUTextureFormat_R32Uint = 13;
const WGPUTextureFormat_R32Sint = 14;
const WGPUTextureFormat_RG16Uint = 15;
const WGPUTextureFormat_RG16Sint = 16;
const WGPUTextureFormat_RG16Float = 17;
const WGPUTextureFormat_RGBA8Unorm = 18;
const WGPUTextureFormat_RGBA8UnormSrgb = 19;
const WGPUTextureFormat_RGBA8Snorm = 20;
const WGPUTextureFormat_RGBA8Uint = 21;
const WGPUTextureFormat_RGBA8Sint = 22;
const WGPUTextureFormat_BGRA8Unorm = 23;
const WGPUTextureFormat_BGRA8UnormSrgb = 24;
const WGPUTextureFormat_RGB10A2Uint = 25;
const WGPUTextureFormat_RGB10A2Unorm = 26;
const WGPUTextureFormat_RG11B10Ufloat = 27;
const WGPUTextureFormat_RGB9E5Ufloat = 28;
const WGPUTextureFormat_RG32Float = 29;
const WGPUTextureFormat_RG32Uint = 30;
const WGPUTextureFormat_RG32Sint = 31;
const WGPUTextureFormat_RGBA16Uint = 32;
const WGPUTextureFormat_RGBA16Sint = 33;
const WGPUTextureFormat_RGBA16Float = 34;
const WGPUTextureFormat_RGBA32Float = 35;
const WGPUTextureFormat_RGBA32Uint = 36;
const WGPUTextureFormat_RGBA32Sint = 37;
const WGPUTextureFormat_Stencil8 = 38;
const WGPUTextureFormat_Depth16Unorm = 39;
const WGPUTextureFormat_Depth24Plus = 40;
const WGPUTextureFormat_Depth24PlusStencil8 = 41;
const WGPUTextureFormat_Depth32Float = 42;
const WGPUTextureFormat_Depth32FloatStencil8 = 43;
const WGPUTextureFormat_BC1RGBAUnorm = 44;
const WGPUTextureFormat_BC1RGBAUnormSrgb = 45;
const WGPUTextureFormat_BC2RGBAUnorm = 46;
const WGPUTextureFormat_BC2RGBAUnormSrgb = 47;
const WGPUTextureFormat_BC3RGBAUnorm = 48;
const WGPUTextureFormat_BC3RGBAUnormSrgb = 49;
const WGPUTextureFormat_BC4RUnorm = 50;
const WGPUTextureFormat_BC4RSnorm = 51;
const WGPUTextureFormat_BC5RGUnorm = 52;
const WGPUTextureFormat_BC5RGSnorm = 53;
const WGPUTextureFormat_BC6HRGBUfloat = 54;
const WGPUTextureFormat_BC6HRGBFloat = 55;
const WGPUTextureFormat_BC7RGBAUnorm = 56;
const WGPUTextureFormat_BC7RGBAUnormSrgb = 57;
const WGPUTextureFormat_ETC2RGB8Unorm = 58;
const WGPUTextureFormat_ETC2RGB8UnormSrgb = 59;
const WGPUTextureFormat_ETC2RGB8A1Unorm = 60;
const WGPUTextureFormat_ETC2RGB8A1UnormSrgb = 61;
const WGPUTextureFormat_ETC2RGBA8Unorm = 62;
const WGPUTextureFormat_ETC2RGBA8UnormSrgb = 63;
const WGPUTextureFormat_EACR11Unorm = 64;
const WGPUTextureFormat_EACR11Snorm = 65;
const WGPUTextureFormat_EACRG11Unorm = 66;
const WGPUTextureFormat_EACRG11Snorm = 67;
const WGPUTextureFormat_ASTC4x4Unorm = 68;
const WGPUTextureFormat_ASTC4x4UnormSrgb = 69;
const WGPUTextureFormat_ASTC5x4Unorm = 70;
const WGPUTextureFormat_ASTC5x4UnormSrgb = 71;
const WGPUTextureFormat_ASTC5x5Unorm = 72;
const WGPUTextureFormat_ASTC5x5UnormSrgb = 73;
const WGPUTextureFormat_ASTC6x5Unorm = 74;
const WGPUTextureFormat_ASTC6x5UnormSrgb = 75;
const WGPUTextureFormat_ASTC6x6Unorm = 76;
const WGPUTextureFormat_ASTC6x6UnormSrgb = 77;
const WGPUTextureFormat_ASTC8x5Unorm = 78;
const WGPUTextureFormat_ASTC8x5UnormSrgb = 79;
const WGPUTextureFormat_ASTC8x6Unorm = 80;
const WGPUTextureFormat_ASTC8x6UnormSrgb = 81;
const WGPUTextureFormat_ASTC8x8Unorm = 82;
const WGPUTextureFormat_ASTC8x8UnormSrgb = 83;
const WGPUTextureFormat_ASTC10x5Unorm = 84;
const WGPUTextureFormat_ASTC10x5UnormSrgb = 85;
const WGPUTextureFormat_ASTC10x6Unorm = 86;
const WGPUTextureFormat_ASTC10x6UnormSrgb = 87;
const WGPUTextureFormat_ASTC10x8Unorm = 88;
const WGPUTextureFormat_ASTC10x8UnormSrgb = 89;
const WGPUTextureFormat_ASTC10x10Unorm = 90;
const WGPUTextureFormat_ASTC10x10UnormSrgb = 91;
const WGPUTextureFormat_ASTC12x10Unorm = 92;
const WGPUTextureFormat_ASTC12x10UnormSrgb = 93;
const WGPUTextureFormat_ASTC12x12Unorm = 94;
const WGPUTextureFormat_ASTC12x12UnormSrgb = 95;

const convertLoadOpToJs = (op) => {
	if (op == WGPULoadOp_Undefined) return undefined;
	if (op == WGPULoadOp_Load) return "load";
	if (op == WGPULoadOp_Clear) return "clear";
	return "load";
}

const convertStoreOpToJs = (op) => {
	if (op == WGPUStoreOp_Undefined) return undefined;
	if (op == WGPUStoreOp_Store) return "store";
	if (op == WGPUStoreOp_Discard) return "discard";
	return "store";
}


const convertCompareFunctionToJs = (c) => {
	if (c == WGPUCompareFunction_Never) return "never";
	if (c == WGPUCompareFunction_Less) return "less";
	if (c == WGPUCompareFunction_Equal) return "equal";
	if (c == WGPUCompareFunction_LessEqual) return "less-equal";
	if (c == WGPUCompareFunction_Greater) return "greater";
	if (c == WGPUCompareFunction_NotEqual) return "not-equal";
	if (c == WGPUCompareFunction_GreaterEqual) return "greater-equal";
	if (c == WGPUCompareFunction_Always) return "always";
	return "always";
}

const convertMipmapFilterModeToJs = (mode) => {
	switch(mode) {
		case WGPUMipmapFilterMode_Nearest: return "nearest";
		case WGPUMipmapFilterMode_Linear: return "linear";
	}
	return "linear";
}

const convertFilterModeToJs = (mode) => {
	switch(mode) {
		case WGPUFilterMode_Nearest: return "nearest";
		case WGPUFilterMode_Linear: return "linear";
	}
	return "linear";
}

const convertAddressModeToJs = (mode) => {
	switch(mode) {
		case WGPUAddressMode_ClampToEdge: return "clamp-to-edge";
		case WGPUAddressMode_Repeat: return "repeat";
		case WGPUAddressMode_MirrorRepeat: return "mirror-repeat";
	}
	return "clamp-to-edge";
}

const convertTextureDimensionToJs = (dimension) => {
	switch(dimension) {
		case WGPUTextureDimension_1D: return "1d";
		case WGPUTextureDimension_2D: return "2d";
		case WGPUTextureDimension_3D: return "3d";
	}

	return "2d";
}

const convertVertexFormatToJs = (format) => {
	switch(format) {
		case WGPUVertexFormat_Uint8: return "uint8";
		case WGPUVertexFormat_Uint8x2: return "uint8x2";
		case WGPUVertexFormat_Uint8x4: return "uint8x4";
		case WGPUVertexFormat_Sint8: return "sint8";
		case WGPUVertexFormat_Sint8x2: return "sint8x2";
		case WGPUVertexFormat_Sint8x4: return "sint8x4";
		case WGPUVertexFormat_Unorm8: return "unorm8";
		case WGPUVertexFormat_Unorm8x2: return "unorm8x2";
		case WGPUVertexFormat_Unorm8x4: return "unorm8x4";
		case WGPUVertexFormat_Snorm8: return "snorm8";
		case WGPUVertexFormat_Snorm8x2: return "snorm8x2";
		case WGPUVertexFormat_Snorm8x4: return "snorm8x4";
		case WGPUVertexFormat_Uint16: return "uint16";
		case WGPUVertexFormat_Uint16x2: return "uint16x2";
		case WGPUVertexFormat_Uint16x4: return "uint16x4";
		case WGPUVertexFormat_Sint16: return "sint16";
		case WGPUVertexFormat_Sint16x2: return "sint16x2";
		case WGPUVertexFormat_Sint16x4: return "sint16x4";
		case WGPUVertexFormat_Unorm16: return "unorm16";
		case WGPUVertexFormat_Unorm16x2: return "unorm16x2";
		case WGPUVertexFormat_Unorm16x4: return "unorm16x4";
		case WGPUVertexFormat_Snorm16: return "snorm16";
		case WGPUVertexFormat_Snorm16x2: return "snorm16x2";
		case WGPUVertexFormat_Snorm16x4: return "snorm16x4";
		case WGPUVertexFormat_Float16: return "float16";
		case WGPUVertexFormat_Float16x2: return "float16x2";
		case WGPUVertexFormat_Float16x4: return "float16x4";
		case WGPUVertexFormat_Float32: return "float32";
		case WGPUVertexFormat_Float32x2: return "float32x2";
		case WGPUVertexFormat_Float32x3: return "float32x3";
		case WGPUVertexFormat_Float32x4: return "float32x4";
		case WGPUVertexFormat_Uint32: return "uint32";
		case WGPUVertexFormat_Uint32x2: return "uint32x2";
		case WGPUVertexFormat_Uint32x3: return "uint32x3";
		case WGPUVertexFormat_Uint32x4: return "uint32x4";
		case WGPUVertexFormat_Sint32: return "sint32";
		case WGPUVertexFormat_Sint32x2: return "sint32x2";
		case WGPUVertexFormat_Sint32x3: return "sint32x3";
		case WGPUVertexFormat_Sint32x4: return "sint32x4";
		case WGPUVertexFormat_Unorm10_10_10_2: return "unorm10-10-10-2";
		case WGPUVertexFormat_Unorm8x4BGRA: return "unorm8x4-bgra";
	}
	return "float32";
}

const blendOperationConvert = (op) => {
	switch(op) {
		case WGPUBlendOperation_Add: return "add";
		case WGPUBlendOperation_Subtract: return "subtract";
		case WGPUBlendOperation_ReverseSubtract: return "reverse-subtract";
		case WGPUBlendOperation_Min: return "min";
		case WGPUBlendOperation_Max: return "max";
	}
}

const blendFactorConvert = (factor) => {
	switch(factor) {
		case WGPUBlendFactor_Zero: return "zero";
		case WGPUBlendFactor_One: return "one";
		case WGPUBlendFactor_Src: return "src";
		case WGPUBlendFactor_OneMinusSrc: return "one-minus-src";
		case WGPUBlendFactor_SrcAlpha: return "src-alpha";
		case WGPUBlendFactor_OneMinusSrcAlpha: return "one-minus-src-alpha";
		case WGPUBlendFactor_Dst: return "dst";
		case WGPUBlendFactor_OneMinusDst: return "one-minus-dst";
		case WGPUBlendFactor_DstAlpha: return "dst-alpha";
		case WGPUBlendFactor_OneMinusDstAlpha: return "one-minus-dst-alpha";
		case WGPUBlendFactor_SrcAlphaSaturated: return "src-alpha-saturated";
		case WGPUBlendFactor_Constant: return "constant";
		case WGPUBlendFactor_OneMinusConstant: return "one-minus-constant";
		case WGPUBlendFactor_Src1: return "src1";
		case WGPUBlendFactor_OneMinusSrc1: return "one-minus-src1";
		case WGPUBlendFactor_Src1Alpha: return "src1-alpha";
		case WGPUBlendFactor_OneMinusSrc1Alpha: return "one-minus-src1-alpha";
	}
}

const textureFormatReverseConvert = (format) => {
	switch(format) {
		case "r8unorm": return WGPUTextureFormat_R8Unorm;
		case "r8snorm": return WGPUTextureFormat_R8Snorm;
		case "r8uint": return WGPUTextureFormat_R8Uint;
		case "r8sint": return WGPUTextureFormat_R8Sint;
		case "r16uint": return WGPUTextureFormat_R16Uint;
		case "r16sint": return WGPUTextureFormat_R16Sint;
		case "r16float": return WGPUTextureFormat_R16Float;
		case "rg8unorm": return WGPUTextureFormat_RG8Unorm;
		case "rg8snorm": return WGPUTextureFormat_RG8Snorm;
		case "rg8uint": return WGPUTextureFormat_RG8Uint;
		case "rg8sint": return WGPUTextureFormat_RG8Sint;
		case "r32float": return WGPUTextureFormat_R32Float;
		case "r32uint": return WGPUTextureFormat_R32Uint;
		case "r32sint": return WGPUTextureFormat_R32Sint;
		case "rg16uint": return WGPUTextureFormat_RG16Uint;
		case "rg16sint": return WGPUTextureFormat_RG16Sint;
		case "rg16float": return WGPUTextureFormat_RG16Float;
		case "rgba8unorm": return WGPUTextureFormat_RGBA8Unorm;
		case "rgba8unorm-srgb": return WGPUTextureFormat_RGBA8UnormSrgb;
		case "rgba8snorm": return WGPUTextureFormat_RGBA8Snorm;
		case "rgba8uint": return WGPUTextureFormat_RGBA8Uint;
		case "rgba8sint": return WGPUTextureFormat_RGBA8Sint;
		case "bgra8unorm": return WGPUTextureFormat_BGRA8Unorm;
		case "bgra8unorm-srgb": return WGPUTextureFormat_BGRA8UnormSrgb;
		case "rgb10a2uint": return WGPUTextureFormat_RGB10A2Uint;
		case "rgb10a2unorm": return WGPUTextureFormat_RGB10A2Unorm;
		case "rg11b10ufloat": return WGPUTextureFormat_RG11B10Ufloat;
		case "rgb9e5ufloat": return WGPUTextureFormat_RGB9E5Ufloat;
		case "rg32float": return WGPUTextureFormat_RG32Float;
		case "rg32uint": return WGPUTextureFormat_RG32Uint;
		case "rg32sint": return WGPUTextureFormat_RG32Sint;
		case "rgba16uint": return WGPUTextureFormat_RGBA16Uint;
		case "rgba16sint": return WGPUTextureFormat_RGBA16Sint;
		case "rgba16float": return WGPUTextureFormat_RGBA16Float;
		case "rgba32float": return WGPUTextureFormat_RGBA32Float;
		case "rgba32uint": return WGPUTextureFormat_RGBA32Uint;
		case "rgba32sint": return WGPUTextureFormat_RGBA32Sint;
		case "stencil8": return WGPUTextureFormat_Stencil8;
		case "depth16unorm": return WGPUTextureFormat_Depth16Unorm;
		case "depth24plus": return WGPUTextureFormat_Depth24Plus;
		case "depth24plus-stencil8": return WGPUTextureFormat_Depth24PlusStencil8;
		case "depth32float": return WGPUTextureFormat_Depth32Float;
		case "depth32float-stencil8": return WGPUTextureFormat_Depth32FloatStencil8;
	}
	return 0;
}

const textureFormatConvert = (format) => {
	switch(format) {
		case WGPUTextureFormat_R8Unorm: return "r8unorm";
		case WGPUTextureFormat_R8Snorm: return "r8snorm";
		case WGPUTextureFormat_R8Uint: return "r8uint";
		case WGPUTextureFormat_R8Sint: return "r8sint";
		case WGPUTextureFormat_R16Uint: return "r16uint";
		case WGPUTextureFormat_R16Sint: return "r16sint";
		case WGPUTextureFormat_R16Float: return "r16float";
		case WGPUTextureFormat_RG8Unorm: return "rg8unorm";
		case WGPUTextureFormat_RG8Snorm: return "rg8snorm";
		case WGPUTextureFormat_RG8Uint: return "rg8uint";
		case WGPUTextureFormat_RG8Sint: return "rg8sint";
		case WGPUTextureFormat_R32Float: return "r32float";
		case WGPUTextureFormat_R32Uint: return "r32uint";
		case WGPUTextureFormat_R32Sint: return "r32sint";
		case WGPUTextureFormat_RG16Uint: return "rg16uint";
		case WGPUTextureFormat_RG16Sint: return "rg16sint";
		case WGPUTextureFormat_RG16Float: return "rg16float";
		case WGPUTextureFormat_RGBA8Unorm: return "rgba8unorm";
		case WGPUTextureFormat_RGBA8UnormSrgb: return "rgba8unorm-srgb";
		case WGPUTextureFormat_RGBA8Snorm: return "rgba8snorm";
		case WGPUTextureFormat_RGBA8Uint: return "rgba8uint";
		case WGPUTextureFormat_RGBA8Sint: return "rgba8sint";
		case WGPUTextureFormat_BGRA8Unorm: return "bgra8unorm";
		case WGPUTextureFormat_BGRA8UnormSrgb: return "bgra8unorm-srgb";
		case WGPUTextureFormat_RGB10A2Uint: return "";
		case WGPUTextureFormat_RGB10A2Unorm: return "";
		case WGPUTextureFormat_RG11B10Ufloat: return "";
		case WGPUTextureFormat_RGB9E5Ufloat: return "";
		case WGPUTextureFormat_RG32Float: return "";
		case WGPUTextureFormat_RG32Uint: return "";
		case WGPUTextureFormat_RG32Sint: return "";
		case WGPUTextureFormat_RGBA16Uint: return "";
		case WGPUTextureFormat_RGBA16Sint: return "rgba16sint";
		case WGPUTextureFormat_RGBA16Float: return "rgba16float";
		case WGPUTextureFormat_RGBA32Float: return "rgba32float";
		case WGPUTextureFormat_RGBA32Uint: return "rgba32uint";
		case WGPUTextureFormat_RGBA32Sint: return "rgba32sint";
		case WGPUTextureFormat_Stencil8: return "stencil8";
		case WGPUTextureFormat_Depth16Unorm: return "depth16unorm";
		case WGPUTextureFormat_Depth24Plus: return "";
		case WGPUTextureFormat_Depth24PlusStencil8: return "";
		case WGPUTextureFormat_Depth32Float: return "depth32float";
		case WGPUTextureFormat_Depth32FloatStencil8: return "depth32float-stencil8";
		case WGPUTextureFormat_BC1RGBAUnorm: return "";
		case WGPUTextureFormat_BC1RGBAUnormSrgb: return "";
		case WGPUTextureFormat_BC2RGBAUnorm: return "";
		case WGPUTextureFormat_BC2RGBAUnormSrgb: return "";
		case WGPUTextureFormat_BC3RGBAUnorm: return "";
		case WGPUTextureFormat_BC3RGBAUnormSrgb: return "";
		case WGPUTextureFormat_BC4RUnorm: return "";
		case WGPUTextureFormat_BC4RSnorm: return "";
		case WGPUTextureFormat_BC5RGUnorm: return "";
		case WGPUTextureFormat_BC5RGSnorm: return "";
		case WGPUTextureFormat_BC6HRGBUfloat: return "";
		case WGPUTextureFormat_BC6HRGBFloat: return "";
		case WGPUTextureFormat_BC7RGBAUnorm: return "";
		case WGPUTextureFormat_BC7RGBAUnormSrgb: return "";
		case WGPUTextureFormat_ETC2RGB8Unorm: return "";
		case WGPUTextureFormat_ETC2RGB8UnormSrgb: return "";
		case WGPUTextureFormat_ETC2RGB8A1Unorm: return "";
		case WGPUTextureFormat_ETC2RGB8A1UnormSrgb: return "";
		case WGPUTextureFormat_ETC2RGBA8Unorm: return "";
		case WGPUTextureFormat_ETC2RGBA8UnormSrgb: return "";
		case WGPUTextureFormat_EACR11Unorm: return "";
		case WGPUTextureFormat_EACR11Snorm: return "";
		case WGPUTextureFormat_EACRG11Unorm: return "";
		case WGPUTextureFormat_EACRG11Snorm: return "";
		case WGPUTextureFormat_ASTC4x4Unorm: return "";
		case WGPUTextureFormat_ASTC4x4UnormSrgb: return "";
		case WGPUTextureFormat_ASTC5x4Unorm: return "";
		case WGPUTextureFormat_ASTC5x4UnormSrgb: return "";
		case WGPUTextureFormat_ASTC5x5Unorm: return "";
		case WGPUTextureFormat_ASTC5x5UnormSrgb: return "";
		case WGPUTextureFormat_ASTC6x5Unorm: return "";
		case WGPUTextureFormat_ASTC6x5UnormSrgb: return "";
		case WGPUTextureFormat_ASTC6x6Unorm: return "";
		case WGPUTextureFormat_ASTC6x6UnormSrgb: return "";
		case WGPUTextureFormat_ASTC8x5Unorm: return "";
		case WGPUTextureFormat_ASTC8x5UnormSrgb: return "";
		case WGPUTextureFormat_ASTC8x6Unorm: return "";
		case WGPUTextureFormat_ASTC8x6UnormSrgb: return "";
		case WGPUTextureFormat_ASTC8x8Unorm: return "";
		case WGPUTextureFormat_ASTC8x8UnormSrgb: return "";
		case WGPUTextureFormat_ASTC10x5Unorm: return "";
		case WGPUTextureFormat_ASTC10x5UnormSrgb: return "";
		case WGPUTextureFormat_ASTC10x6Unorm: return "";
		case WGPUTextureFormat_ASTC10x6UnormSrgb: return "";
		case WGPUTextureFormat_ASTC10x8Unorm: return "";
		case WGPUTextureFormat_ASTC10x8UnormSrgb: return "";
		case WGPUTextureFormat_ASTC10x10Unorm: return "";
		case WGPUTextureFormat_ASTC10x10UnormSrgb: return "";
		case WGPUTextureFormat_ASTC12x10Unorm: return "";
		case WGPUTextureFormat_ASTC12x10UnormSrgb: return "";
		case WGPUTextureFormat_ASTC12x12Unorm: return "";
	}
}

let device_used = null;
let data_view = null;

const getU64 = (ptr, offset) => {
	return data_view.getBigUint64(Number(ptr) + Number(offset), true);
}
const getU32 = (ptr, offset) => {
	return data_view.getUint32(Number(ptr) + Number(offset), true);
}
const getS32 = (ptr, offset) => {
	return data_view.getInt32(Number(ptr) + Number(offset), true);
}
const getF64 = (ptr, offset) => {
	return data_view.getFloat64(Number(ptr) + Number(offset), true);
}
const getF32 = (ptr, offset) => {
	return data_view.getFloat32(Number(ptr) + Number(offset), true);
}

const setU8 = (ptr, offset, value) => {
	data_view.setUint8(Number(ptr) + Number(offset), Number(value));
}

const setU32 = (ptr, offset, value) => {
	data_view.setUint32(Number(ptr) + Number(offset), Number(value), true);
}
const setU64 = (ptr, offset, value) => {
	data_view.setBigUint64(Number(ptr) + Number(offset), BigInt(value), true);
}

const getString = (stringview_ptr) => {
	const data = getU64(stringview_ptr, 0);
	const length = getU64(stringview_ptr, 8);
	return new TextDecoder().decode(
		new Uint8Array(jai_exports.memory.buffer, Number(data), Number(length))
	);
}

jai_imports.js_memory_grew = () => {
	data_view = new DataView(jai_exports.memory.buffer);
}

jai_imports.jsCreateInstance = (params_ptr, returns_ptr) => {
	data_view = new DataView(jai_exports.memory.buffer);
	object_map_counter += 1;
	object_map[object_map_counter] = navigator.gpu;
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsInstanceRequestAdapter = (params_ptr, returns_ptr) => {
	switch(wasm_pause()) {
		case 0: (async () => {
			const adapter = await navigator.gpu.requestAdapter();

			object_map_counter += 1;
			object_map[object_map_counter] = adapter;
			setU64(returns_ptr, 0, object_map_counter);
			return +1;
		})().then(wasm_resume); break;
	}
}

jai_imports.jsAdapterGetLimits = (params_ptr, returns_ptr) => {
	const adapter_idx = getU64(params_ptr, 0);
	if (adapter_idx <= 0) {
		setU32(returns_ptr, 0, WGPUStatus_ERROR);
		return;
	}

	const adapter = object_map[adapter_idx];

	const limits_ptr = getU64(params_ptr, 8);

	setU32(limits_ptr, 8 + 0, adapter.limits.maxTextureDimension1D);
	setU32(limits_ptr, 8 + 4, adapter.limits.maxTextureDimension2D);
	setU32(limits_ptr, 8 + 8, adapter.limits.maxTextureDimension3D);
	setU32(limits_ptr, 8 + 12, adapter.limits.maxTextureArrayLayers);
	setU32(limits_ptr, 8 + 16, adapter.limits.maxBindGroups);
	setU32(limits_ptr, 8 + 20, adapter.limits.maxBindGroupsPlusVertexBuffers);
	setU32(limits_ptr, 8 + 24, adapter.limits.maxBindingsPerBindGroup);
	setU32(limits_ptr, 8 + 28, adapter.limits.maxDynamicUniformBuffersPerPipelineLayout);
	setU32(limits_ptr, 8 + 32, adapter.limits.maxDynamicStorageBuffersPerPipelineLayout);
	setU32(limits_ptr, 8 + 36, adapter.limits.maxSampledTexturesPerShaderStage);
	setU32(limits_ptr, 8 + 40, adapter.limits.maxSamplersPerShaderStage);
	setU32(limits_ptr, 8 + 44, adapter.limits.maxStorageBuffersPerShaderStage);
	setU32(limits_ptr, 8 + 48, adapter.limits.maxStorageTexturesPerShaderStage);
	setU32(limits_ptr, 8 + 52, adapter.limits.maxUniformBuffersPerShaderStage);
	setU32(limits_ptr, 8 + 56, adapter.limits.maxUniformBufferBindingSize);
	setU32(limits_ptr, 8 + 60, adapter.limits.maxStorageBufferBindingSize);
	setU32(limits_ptr, 8 + 64, adapter.limits.minUniformBufferOffsetAlignment);
	setU32(limits_ptr, 8 + 68, adapter.limits.minStorageBufferOffsetAlignment);
	setU32(limits_ptr, 8 + 72, adapter.limits.maxVertexBuffers);
	setU32(limits_ptr, 8 + 76, adapter.limits.maxBufferSize);
	setU32(limits_ptr, 8 + 80, adapter.limits.maxVertexAttributes);
	setU32(limits_ptr, 8 + 84, adapter.limits.maxVertexBufferArrayStride);
	setU32(limits_ptr, 8 + 88, adapter.limits.maxInterStageShaderVariables);
	setU32(limits_ptr, 8 + 92, adapter.limits.maxColorAttachments);
	setU32(limits_ptr, 8 + 96, adapter.limits.maxColorAttachmentBytesPerSample);
	setU32(limits_ptr, 8 + 100, adapter.limits.maxComputeWorkgroupStorageSize);
	setU32(limits_ptr, 8 + 104, adapter.limits.maxComputeInvocationsPerWorkgroup);
	setU32(limits_ptr, 8 + 108, adapter.limits.maxComputeWorkgroupSizeX);
	setU32(limits_ptr, 8 + 112, adapter.limits.maxComputeWorkgroupSizeY);
	setU32(limits_ptr, 8 + 116, adapter.limits.maxComputeWorkgroupSizeZ);
	setU32(limits_ptr, 8 + 120, adapter.limits.maxComputeWorkgroupsPerDimension);

	setU32(returns_ptr, 0, WGPUStatus_SUCCESS);
}


const FEATURE_Undefined                      = 0;
const FEATURE_DepthClipControl               = 1;
const FEATURE_Depth32FloatStencil8           = 2;
const FEATURE_TimestampQuery                 = 3;
const FEATURE_TextureCompressionBC           = 4;
const FEATURE_TextureCompressionBCSliced3D   = 5;
const FEATURE_TextureCompressionETC2         = 6;
const FEATURE_TextureCompressionASTC         = 7;
const FEATURE_TextureCompressionASTCSliced3D = 8;
const FEATURE_IndirectFirstInstance          = 9;
const FEATURE_ShaderF16                      = 10;
const FEATURE_RG11B10UfloatRenderable        = 11;
const FEATURE_BGRA8UnormStorage              = 12;
const FEATURE_Float32Filterable              = 13;
const FEATURE_Float32Blendable               = 14;
const FEATURE_ClipDistances                  = 15;
const FEATURE_DualSourceBlending             = 16;

const feature_name_to_enum = (name) => {
	if (name == "depth-clip-control")
		return FEATURE_DepthClipControl;
	if (name == "depth32float-stencil8")
		return FEATURE_Depth32FloatStencil8;
	if (name == "timestamp-query")
		return FEATURE_TimestampQuery;
	if (name == "texture-compression-bc")
		return FEATURE_TextureCompressionBC;
	if (name == "texture-compression-bcsliced3d")
		return FEATURE_TextureCompressionBCSliced3D;
	if (name == "texture-compression-etc2")
		return FEATURE_TextureCompressionETC2;
	if (name == "texture-compression-astc")
		return FEATURE_TextureCompressionASTC;
	if (name == "texture-compression-astcsliced3d")
		return FEATURE_TextureCompressionASTCSliced3D;
	if (name == "indirect-first-instance")
		return FEATURE_IndirectFirstInstance;
	if (name == "shader-f16")
		return FEATURE_ShaderF16;
	if (name == "rg11b10ufloat-renderable")
		return FEATURE_RG11B10UfloatRenderable;
	if (name == "bgra8unorm-storage")
		return FEATURE_BGRA8UnormStorage;
	if (name == "float32-filterable")
		return FEATURE_Float32Filterable;
	if (name == "float32-blendable")
		return FEATURE_Float32Blendable;
	if (name == "clip-distances")
		return FEATURE_ClipDistances;
	if (name == "dual-source-blending")
		return FEATURE_DualSourceBlending;
	return -1;
}
const feature_enum_to_name = (e) => {
	if (e == FEATURE_DepthClipControl)
		return "depth-clip-control";
	if (e == FEATURE_Depth32FloatStencil8)
		return "depth32float-stencil8";
	if (e == FEATURE_TimestampQuery)
		return "timestamp-query";
	if (e == FEATURE_TextureCompressionBC)
		return "texture-compression-bc";
	if (e == FEATURE_TextureCompressionBCSliced3D)
		return "texture-compression-bcsliced3d";
	if (e == FEATURE_TextureCompressionETC2)
		return "texture-compression-etc2";
	if (e == FEATURE_TextureCompressionASTC)
		return "texture-compression-astc";
	if (e == FEATURE_TextureCompressionASTCSliced3D)
		return "texture-compression-astcsliced3d";
	if (e == FEATURE_IndirectFirstInstance)
		return "indirect-first-instance";
	if (e == FEATURE_ShaderF16)
		return "shader-f16";
	if (e == FEATURE_RG11B10UfloatRenderable)
		return "rg11b10ufloat-renderable";
	if (e == FEATURE_BGRA8UnormStorage)
		return "bgra8unorm-storage";
	if (e == FEATURE_Float32Filterable)
		return "float32-filterable";
	if (e == FEATURE_Float32Blendable)
		return "float32-blendable";
	if (e == FEATURE_ClipDistances)
		return "clip-distances";
	if (e == FEATURE_DualSourceBlending)
		return "dual-source-blending";
	return "";
}

jai_imports.jsAdapterGetFeatures = (params_ptr, returns_ptr) => {
	const adapter_idx = getU64(params_ptr, 0);
	if (adapter_idx <= 0) {
		setU32(returns_ptr, 0, WGPUStatus_ERROR);
		return;
	}

	const adapter = object_map[adapter_idx];
	const n = adapter.features.size;

	const memory = jai_exports.context_alloc(jai_context, BigInt(n * 4));

	const features_ptr = getU64(params_ptr, 8);
	setU64(features_ptr, 8, memory);
	let cursor = 0;
	for (const feature of adapter.features) {
		const idx = feature_name_to_enum(feature);
		if (idx < 0)
			continue;
		setU32(memory, cursor, idx);
		cursor += 4;
	}
	setU64(features_ptr, 0, cursor / 4);
}

jai_imports.jsSupportedFeaturesFreeMembers = (params_ptr, returns_ptr) => {
	const features_ptr = getU64(params_ptr, 0);
	if (features_ptr == 0)
		return;

	const n = getU64(features_ptr, 0);
	const memory = getU64(features_ptr, 8);

	jai_exports.context_free(jai_context, memory);
}

jai_imports.jsAdapterRelease = (params_ptr, returns_ptr) => {
	const adapter_idx = getU64(params_ptr, 0);
	if (adapter_idx <= 0) {
		return;
	}

	const adapter = object_map[adapter_idx];
	if (!adapter) {
		return;
	}

	// Release the adapter
	object_map[adapter_idx] = null;
}

jai_imports.jsAdapterRequestDevice = (params_ptr, returns_ptr) => {
	const adapter_idx = getU64(params_ptr, 0);
	const descriptor_ptr = getU64(params_ptr, 8);
	if (adapter_idx == 0 || descriptor_ptr == 0) {
		return;
	}
	const adapter = object_map[adapter_idx];

	const feature_count = getU64(descriptor_ptr, 8 + 16);
	const feature_ptr   = getU64(descriptor_ptr, 8 + 16 + 8);
	const features = [];
	for (let i = 0; i < feature_count; i++) {
		const feature = getU32(feature_ptr, i * 4);
		const feature_name = feature_enum_to_name(feature);
		features.push(feature_name);
	}

	const limit_ptr = getU64(descriptor_ptr, 8 + 16 + 8 + 8); // ??
	const defaultQueue_ptr = getU64(descriptor_ptr, 8 + 16 + 8 + 8 + 8); // ??
	const deviceLostCallback_ptr = getU64(descriptor_ptr, 8 + 16 + 8 + 8 + 8 + 8); // ??
	const uncapturedExceptions_ptr = getU64(descriptor_ptr, 8 + 16 + 8 + 8 + 8 + 8 + 8);

	const uncapturedExceptionsCallback = getU64(uncapturedExceptions_ptr, 8);
	const uncapturedExceptionsUserData1 = getU64(uncapturedExceptions_ptr, 16);
	const uncapturedExceptionsUserData2 = getU64(uncapturedExceptions_ptr, 24);

	const jsDescriptor = {
		defaultQueue: { label: "<default-queue>" },
		label: "<device-label>",
		requiredFeatures: features,
		requiredLimits: [],
	};
	switch(wasm_pause()) {
		case 0: (async () => {
			const device = await adapter.requestDevice(jsDescriptor);
			device.lost.then((info) => {
				console.error("WebGPU device lost:", info);
			});
			device_used = device;
			
			object_map_counter += 1;
			object_map[object_map_counter] = device;

			const device_idx = object_map_counter;
			
			device.addEventListener('uncapturederror', event => {
				const userData1 = uncapturedExceptionsUserData1;
				const userData2 = uncapturedExceptionsUserData2;

				const string_ptr = jai_exports.context_alloc(
					jai_context, BigInt(event.error.message.length)
				);

				jai_exports.jaiAdapterRequestDeviceErrorCallback(
					jai_context,
					BigInt(device_idx),
					BigInt(string_ptr),
					BigInt(event.error.message.length),
					BigInt(uncapturedExceptionsCallback),
					BigInt(uncapturedExceptionsUserData1),
					BigInt(uncapturedExceptionsUserData2)
				);
			});
			setU64(returns_ptr, 0, object_map_counter);
		})().then(wasm_resume); break;
	}
}

jai_imports.jsDeviceGetQueue = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}


	object_map_counter += 1;
	object_map[object_map_counter] = device.queue;

	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsQueueRelease = (params_ptr, returns_ptr) => {
	const queue_idx = getU64(params_ptr, 0);
	if (queue_idx <= 0) {
		return;
	}

	const queue = object_map[queue_idx];
	if (!queue) {
		return;
	}

	// Release the queue
	object_map[queue_idx] = null;
}

jai_imports.jsQueueSubmit = (params_ptr, returns_ptr) => {
	const queue_idx = getU64(params_ptr, 0);
	const commandCount = getU64(params_ptr, 8);
	const commands_ptr = getU64(params_ptr, 16);
	if (queue_idx <= 0 || (commandCount > 0 && commands_ptr == 0)) {
		return;
	}

	const queue = object_map[queue_idx];
	if (!queue) {
		return;
	}

	// Submit the commands to the queue
	const commands = [];
	for (let i = 0; i < commandCount; i++) {
		const command_idx = getU64(commands_ptr, i * 8);
		const command = object_map[command_idx];
		if (!command) {
			continue;
		}
		commands.push(command);
	}

	queue.submit(commands);
}

jai_imports.jsQueueWriteBuffer = (params_ptr, returns_ptr) => {
	const queue_idx = getU64(params_ptr, 0);
	const buffer_idx = getU64(params_ptr, 8);
	const bufferOffset = getU64(params_ptr, 16);
	const data_ptr = getU64(params_ptr, 24);
	const dataSize = getU64(params_ptr, 32);

	if (queue_idx <= 0 || buffer_idx <= 0 || data_ptr == 0 || dataSize == 0) {
		return;
	}

	const queue = object_map[queue_idx];
	const buffer = object_map[buffer_idx];

	if (!queue || !buffer) {
		return;
	}

	queue.writeBuffer(
		buffer,
		Number(bufferOffset),
		new DataView(jai_exports.memory.buffer, Number(data_ptr), Number(dataSize))
	);
}

const TEXTURE_ASPECT_MAP = {
	1: "all",
	2: "depth-only",
	3: "stencil-only",
};

jai_imports.jsQueueWriteTexture = (params_ptr, returns_ptr) => {
	const queue_idx = getU64(params_ptr, 0);
	const info_ptr = getU64(params_ptr, 8);
	const data_ptr = getU64(params_ptr, 16);
	const dataSize = getU64(params_ptr, 24);
	const dataLayout_ptr = getU64(params_ptr, 32);
	const writeSize_ptr = getU64(params_ptr, 40);

	if (queue_idx == 0 || info_ptr == 0 || data_ptr == 0 || dataSize == 0 || dataLayout_ptr == 0 || writeSize_ptr == 0) {
		return;
	}

	const queue = object_map[queue_idx];
	if (!queue) {
		return;
	}

	const texture_idx = getU64(info_ptr, 0);
	const mipLevel = getU32(info_ptr, 8);
	const originX = getU32(info_ptr, 12);
	const originY = getU32(info_ptr, 16);
	const originZ = getU32(info_ptr, 20);
	const aspect = TEXTURE_ASPECT_MAP[getU32(info_ptr, 24)];

	const texture = object_map[texture_idx];
	if (!texture) {
		return;
	}

	const layout_offset = getU64(dataLayout_ptr, 0);
	const bytesPerRow = getU32(dataLayout_ptr, 8);
	const rowsPerImage = getU32(dataLayout_ptr, 12);

	const width = getU32(writeSize_ptr, 0);
	const height = getU32(writeSize_ptr, 4);
	const depth = getU32(writeSize_ptr, 8);

	queue.writeTexture(
		{
			aspect: aspect,
			mipLevel: mipLevel,
			origin: [originX, originY, originZ],
			texture: texture
		},
		new DataView(jai_exports.memory.buffer, Number(data_ptr), Number(dataSize)),
		{
			offset: Number(layout_offset),
			bytesPerRow: Number(bytesPerRow),
			rowsPerImage: Number(rowsPerImage)
		},
		[width, height, depth]
	);
}

jai_imports.jsDeviceCreateCommandEncoder = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}
	
	const device = object_map[device_idx];
	if (!device) {
		return;
	}
	
	const descriptor_ptr = getU64(params_ptr, 8);
	const label_ptr = descriptor_ptr > 0 ? getU64(descriptor_ptr, 8) : 0;
	const label = label_ptr > 0 ? getString(label_ptr) : "default-command-encoder-label";

	object_map_counter += 1;
	object_map[object_map_counter] = device.createCommandEncoder({
		label: label
	});

	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsCommandEncoderFinish = (params_ptr, returns_ptr) => {
	const encoder_idx = getU64(params_ptr, 0);
	const descriptor_ptr = getU64(params_ptr, 8);

	if (encoder_idx <= 0 || descriptor_ptr == 0) {
		return;
	}

	const encoder = object_map[encoder_idx];
	if (!encoder) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);

	object_map_counter += 1;
	object_map[object_map_counter] = encoder.finish({label});

	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsCommandEncoderInsertDebugMarker = (params_ptr, returns_ptr) => {
	const encoder_idx = getU64(params_ptr, 0);
	const label_ptr = getU64(params_ptr, 8);

	if (encoder_idx <= 0 || label_ptr == 0) {
		return;
	}

	const encoder = object_map[encoder_idx];
	if (!encoder) {
		return;
	}

	const label = getString(label_ptr);

	encoder.insertDebugMarker(label);
}

jai_imports.jsCommandBufferRelease = (params_ptr, returns_ptr) => {
	const commandBuffer_idx = getU64(params_ptr, 0);
	if (commandBuffer_idx <= 0) {
		return;
	}

	object_map[commandBuffer_idx] = null;
}

jai_imports.jsCommandEncoderRelease = (params_ptr, returns_ptr) => {
	const encoder_idx = getU64(params_ptr, 0);
	if (encoder_idx <= 0) {
		return;
	}

	object_map[encoder_idx] = null;
}

jai_imports.jsDeviceCreateBuffer = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const usage = getU64(descriptor_ptr, 24);
	const size = getU64(descriptor_ptr, 32);
	const mappedAtCreation = getU32(descriptor_ptr, 40);

	object_map_counter += 1;
	object_map[object_map_counter] = device.createBuffer({
		label: label,
		mappedAtCreation: mappedAtCreation > 0,
		size: Number(size),
		usage: Number(usage)
	});

	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsBufferRelease = (params_ptr, returns_ptr) => {
	const buffer_idx = getU64(params_ptr, 0);
	if (buffer_idx <= 0) {
		return;
	}

	object_map[buffer_idx] = null;
}

jai_imports.jsBufferGetMappedRange = (params_ptr, returns_ptr) => {
	const buffer_idx = getU64(params_ptr, 0);
	if (buffer_idx <= 0) {
		return;
	}

	const buffer = object_map[buffer_idx];
	if (!buffer) {
		return;
	}

	const offset = getU64(params_ptr, 8);
	const size = getU64(params_ptr, 16);

	const mapped_range = buffer.getMappedRange(offset, size);
	buffer_to_pointer_map[buffer_idx] = {
		data: jai_exports.context_alloc(
			jai_context, BigInt(mapped_range.byteLength)
		),
		size: mapped_range.byteLength,
		jsBuffer: mapped_range
	};

	new Uint8Array(
		jai_exports.memory.buffer,
		buffer_to_pointer_map[buffer_idx].data,
		mapped_range.byteLength
	).set(new Uint8Array(mapped_range));

	setU64(returns_ptr, 0, buffer_to_pointer_map[buffer_idx]);
}

jai_imports.jsBufferUnmap = (params_ptr, returns_ptr) => {
	const buffer_idx = getU64(params_ptr, 0);
	if (buffer_idx <= 0) {
		return;
	}

	const buffer = object_map[buffer_idx];
	if (!buffer) {
		return;
	}

	const mapping = buffer_to_pointer_map[buffer_idx];
	if (!mapping) {
		return;
	}

	new Uint8Array(mapping.jsBuffer).set(
		new Uint8Array(jai_exports.memory.buffer, mapping.data, mapping.size)
	);
	buffer.unmap();
}

jai_imports.jsInstanceCreateSurface = (params_ptr, returns_ptr) => {
	const instance_idx = getU64(params_ptr, 0);
	if (instance_idx == 0) {
		return;
	}

	const instance = object_map[instance_idx];
	if (!instance) {
		return;
	}

	object_map_counter += 1;
	object_map[object_map_counter] = document.createElement('canvas');
	object_map[object_map_counter].width = 1366;
	object_map[object_map_counter].height = 768;
	const canvas = object_map[object_map_counter];
	canvas.id = "webgpu-canvas";
	document.body.appendChild(canvas);

	setU64(returns_ptr, 0, object_map_counter);
}


const getSurfaceConfiguration = (ptr) => {
	const nextInChain_ptr = getU64(ptr, 0);
	const device_idx = getU64(ptr, 8);
	const formatRaw = getU32(ptr, 16);
	const usageRaw = getU64(ptr, 24);
	const width = getU32(ptr, 32);
	const height = getU32(ptr, 36);
	const viewFormatCounts = getU64(ptr, 40);
	const viewFormats_ptr = getU64(ptr, 48);
	const alphaMode = getU32(ptr, 56);
	const presentModeRaw = getU32(ptr, 60);

	const device = object_map[device_idx];
	if (!device) {
		return null;
	}

	const format = textureFormatConvert(formatRaw);
	const usage = Number(usageRaw);

	return {
		device,
		format,
		usage,
		width,
		height,
		alphaMode:
			alphaMode == 0
			? "opaque"
			: (alphaMode == 1
				? "premultiplied"
				: (alphaMode == 2
					? "unpremultiplied"
					: "inherit"
				)
			),
	};
}

jai_imports.jsSurfaceConfigure = (params_ptr, returns_ptr) => {
	const surface_idx = getU64(params_ptr, 0);
	if (surface_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const surface = object_map[surface_idx];
	if (!surface) {
		return;
	}

	// In WebGPU, the "surface" is just the canvas element
	object_map_counter += 1;
	object_map[object_map_counter] = surface.getContext('webgpu');
	
	// Configure the context
	const configre = getSurfaceConfiguration(descriptor_ptr);
	if (!configre) {
		return;
	}
	
	surface.getContext("webgpu").configure(configre);
	// surface.width = configre.width;
	// surface.height = configre.height;
}

jai_imports.jsDeviceCreateShaderModule = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const nextInChain_ptr = getU64(descriptor_ptr, 0);
	const label = getString(descriptor_ptr + 8n);

	const chain_next_ptr = getU64(nextInChain_ptr, 0);
	const chain_type = getU32(nextInChain_ptr, 8);
	if (chain_type !== WGPUStype_ShaderSourceWGSL) {
		console.error("Unsupported shader module source type:", chain_type);
		return;
	}

	const code = getString(nextInChain_ptr + 16n);

	object_map_counter += 1;
	object_map[object_map_counter] = device.createShaderModule({
		label: label,
		code: code
	});

	setU64(returns_ptr, 0, object_map_counter);
}

const convertVertexStepModeToJs = (mode) => {
	if (mode == WGPUVertexStepMode_Vertex)
		return "vertex";
	if (mode == WGPUVertexStepMode_Instance)
		return "instance";
	return "vertex";
}

const getVertexState = (ptr) => {
	const module_idx = getU64(ptr, 8);
	const entryPoint = getString(ptr + 16n);
	const constantCount = getU64(ptr, 32);
	const constants_ptr = getU64(ptr, 40);
	const bufferCount = getU64(ptr, 48);
	const buffers_ptr = getU64(ptr, 56);

	const module = object_map[module_idx];
	if (!module) {
		return null;
	}

	const constants = {};
	let cursor = 0;
	for (let i = 0; i < constantCount; i++) {
		cursor += 8;
		const key = getString(constants_ptr + BigInt(cursor));
		cursor += 16;
		const value = getF64(constants_ptr, cursor);
		cursor += 8;
		constants[key] = value;
	}

	const buffers = [];
	cursor = 0;
	for (let i = 0; i < bufferCount; i++) {
		const stepMode = getU32(buffers_ptr, cursor);
		cursor += 8;
		const arrayStride = getU64(buffers_ptr, cursor);
		cursor += 8;
		const attributeCount = getU64(buffers_ptr, cursor);
		cursor += 8;
		const attributes_ptr = getU64(buffers_ptr, cursor);
		cursor += 8;
		
		const attributes = [];
		let attr_cursor = 0;
		for (let j = 0; j < attributeCount; j++) {
			const format = getU32(attributes_ptr, attr_cursor);
			attr_cursor += 8;
			const offset = getU64(attributes_ptr, attr_cursor);
			attr_cursor += 8;
			const shaderLocation = getU32(attributes_ptr, attr_cursor);
			attr_cursor += 8;

			attributes.push({
				format: convertVertexFormatToJs(format),
				offset: Number(offset),
				shaderLocation: Number(shaderLocation)
			});
		}
		buffers.push({
			stepMode: convertVertexStepModeToJs(stepMode),
			arrayStride: Number(arrayStride),
			attributes
		});
	}

	return {
		module,
		constants,
		entryPoint,
		buffers
	};
}

const getFragmentState = (ptr) => {
	const module_idx = getU64(ptr, 8);
	const entryPoint = getString(ptr + 16n);
	const constantCount = getU64(ptr, 32);
	const constants_ptr = getU64(ptr, 40);
	const targetCount = getU64(ptr, 48);
	const targets_ptr = getU64(ptr, 56);

	const module = object_map[module_idx];
	if (!module) {
		return null;
	}

	const constants = {};
	let cursor = 0;
	for (let i = 0; i < constantCount; i++) {
		cursor += 8;
		const key = getString(constants_ptr + BigInt(cursor));
		cursor += 16;
		const value = getF64(constants_ptr, cursor);
		cursor += 8;
		constants[key] = value;
	}

	const targets = [];
	cursor = 0;
	for (let i = 0; i < targetCount; i++) {
		cursor += 8; // skip nextInChain
		const formatRaw = getU32(targets_ptr, cursor);
		const format = textureFormatConvert(formatRaw);
		cursor += 8;
		const blendState_ptr = getU64(targets_ptr, cursor);
		cursor += 8;
		const writeMask = getU64(targets_ptr, cursor);
		cursor += 8;

		let blend = undefined;
		if (blendState_ptr != 0) {
			const color = {
				operation: blendOperationConvert(getU32(blendState_ptr, 0)),
				srcFactor: blendFactorConvert(getU32(blendState_ptr, 4)),
				dstFactor: blendFactorConvert(getU32(blendState_ptr, 8)),
			};
			const alpha = {
				operation: blendOperationConvert(getU32(blendState_ptr, 12)),
				srcFactor: blendFactorConvert(getU32(blendState_ptr, 16)),
				dstFactor: blendFactorConvert(getU32(blendState_ptr, 20)),
			};
			blend = { color, alpha };
		}

		targets.push({
			format,
			blend,
			writeMask: Number(writeMask)
		});
	}

	return {
		module,
		constants,
		entryPoint,
		targets
	};
}

const getPrimitiveState = (ptr) => {
	const topology = getU32(ptr, 8);
	const stripIndexFormat = getU32(ptr, 12);
	const frontFace = getU32(ptr, 16);
	const cullMode = getU32(ptr, 20);
	const unclippedDepth = getU32(ptr, 24);

	let obj = {};
	if (cullMode == WGPUCullMode_None)
		obj.cullMode = "none";
	if (cullMode == WGPUCullMode_Front)
		obj.cullMode = "front";
	if (cullMode == WGPUCullMode_Back)
		obj.cullMode = "back";

	if (frontFace == WGPUFrontFace_CCW)
		obj.frontFace = "ccw";
	if (frontFace == WGPUFrontFace_CW)
		obj.frontFace = "cw";

	if (stripIndexFormat == WGPUIndexFormat_Uint16)
		obj.stripIndexFormat = "uint16";
	if (stripIndexFormat == WGPUIndexFormat_Uint32)
		obj.stripIndexFormat = "uint32";

	if (topology == WGPUPrimitiveTopology_PointList)
		obj.topology = "point-list";
	if (topology == WGPUPrimitiveTopology_LineList)
		obj.topology = "line-list";
	if (topology == WGPUPrimitiveTopology_LineStrip)
		obj.topology = "line-strip";
	if (topology == WGPUPrimitiveTopology_TriangleList)
		obj.topology = "triangle-list";
	if (topology == WGPUPrimitiveTopology_TriangleStrip)
		obj.topology = "triangle-strip";

	obj.unclippedDepth = unclippedDepth != 0;

	return obj;
}

const getMultisampleState = (ptr) => {
	const count = getU32(ptr, 8);
	const mask = getU32(ptr, 12);
	const alphaToCoverageEnabled = getU32(ptr, 16);
	
	return {
		count,
		mask,
		alphaToCoverageEnabled: alphaToCoverageEnabled != 0
	};
}

const getDepthStencilState = (ptr) => {
	const format = getU32(ptr, 8);
	const depthWriteEnabled = getU32(ptr, 12);
	const depthCompare = getU32(ptr, 16);
	const stencilFrontCompare = getU32(ptr, 20);
	const stencilFrontFailOp = getU32(ptr, 24);
	const stencilFrontDepthFailOp = getU32(ptr, 28);
	const stencilFrontPassOp = getU32(ptr, 32);
	const stencilBackCompare = getU32(ptr, 36);
	const stencilBackFailOp = getU32(ptr, 40);
	const stencilBackDepthFailOp = getU32(ptr, 44);
	const stencilBackPassOp = getU32(ptr, 48);
	const stencilReadMask = getU32(ptr, 52);
	const stencilWriteMask = getU32(ptr, 56);
	const depthBias = getU32(ptr, 60);
	const depthBiasSlopeScale = getF64(ptr, 64);
	const depthBiasClamp = getF64(ptr, 72);

	let obj = {
		depthBias,
		depthBiasSlopeScale,
		depthBiasClamp,
	};

	const depthFailOpConvert = (op) => {
		if (op == WGPUStencilOperation_Keep) return "keep";
		if (op == WGPUStencilOperation_Zero) return "zero";
		if (op == WGPUStencilOperation_Replace) return "replace";
		if (op == WGPUStencilOperation_Invert) return "invert";
		if (op == WGPUStencilOperation_IncrementClamp) return "increment-clamp";
		if (op == WGPUStencilOperation_DecrementClamp) return "decrement-clamp";
		if (op == WGPUStencilOperation_IncrementWrap) return "increment-wrap";
		if (op == WGPUStencilOperation_DecrementWrap) return "decrement-wrap";
		return "keep";
	}

	obj.depthCompare = convertCompareFunctionToJs(depthCompare);
	obj.depthWriteEnabled = depthWriteEnabled != 0;
	obj.format = textureFormatConvert(format);
	obj.stencilBack = {
		compare: convertCompareFunctionToJs(stencilBackCompare),
		failOp: depthFailOpConvert(stencilBackFailOp),
		depthFailOp: depthFailOpConvert(stencilBackDepthFailOp),
		passOp: depthFailOpConvert(stencilBackPassOp),
	};
	obj.stencilFront = {
		compare: convertCompareFunctionToJs(stencilFrontCompare),
		failOp: depthFailOpConvert(stencilFrontFailOp),
		depthFailOp: depthFailOpConvert(stencilFrontDepthFailOp),
		passOp: depthFailOpConvert(stencilFrontPassOp),
	};
	obj.stencilReadMask = stencilReadMask;
	obj.stencilWriteMask = stencilWriteMask;

	return obj;
}

jai_imports.jsDeviceCreateRenderPipeline = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const layout = getU64(descriptor_ptr, 24n);
	const vertexState = getVertexState(descriptor_ptr + 32n);
	const primitiveState = getPrimitiveState(descriptor_ptr + 98n);
	const depthStencil_ptr = getU64(descriptor_ptr, 128);
	const depthStencilState = depthStencil_ptr ? getDepthStencilState(depthStencil_ptr) : undefined;
	const multisample_ptr = getMultisampleState(descriptor_ptr + 136n);
	const fragment_ptr = getU64(descriptor_ptr, 160);
	const fragmentState = fragment_ptr ? getFragmentState(fragment_ptr) : undefined;

	if (!vertexState) {
		console.error("Invalid vertex state in pipeline descriptor");
		return;
	}
	if (fragment_ptr != 0 && !fragmentState) {
		console.error("Invalid fragment state in pipeline descriptor");
		return;
	}
	const jsDescriptor = {
		label,
		layout: layout == 0 ? "auto" : object_map[layout],
		vertex: vertexState,
		primitive: primitiveState,
		depthStencil: depthStencilState,
		multisample: multisample_ptr,
		fragment: fragmentState,
	};

	object_map_counter += 1;
	object_map[object_map_counter] = device.createRenderPipeline(jsDescriptor);

	setU64(returns_ptr, 0, object_map_counter);
}

const getRenderPassColorAttachment = (ptr) => {
	const view_idx = getU64(ptr, 8);
	const depthSlice = getU32(ptr, 16) == 0 ? undefined : getU32(ptr, 16);
	const resolveTarget_idx = getU64(ptr, 20);
	const loadOp = getU32(ptr, 32);
	const storeOp = getU32(ptr, 36);
	const clearValueR = getF64(ptr, 40);
	const clearValueG = getF64(ptr, 48);
	const clearValueB = getF64(ptr, 56);
	const clearValueA = getF64(ptr, 64);

	const view = object_map[view_idx];
	if (!view) {
		return null;
	}
	
	const resolveTarget = resolveTarget_idx != 0 ? object_map[resolveTarget_idx] : undefined;
	if (resolveTarget_idx != 0 && !resolveTarget) {
		return null;
	}

	const color = {
		r: clearValueR,
		g: clearValueG,
		b: clearValueB,
		a: clearValueA,
	};

	let jsLoadOp = convertLoadOpToJs(loadOp);
	let jsStoreOp = convertStoreOpToJs(storeOp);

	return {
		view,
		resolveTarget,
		depthSlice,
		loadOp: jsLoadOp,
		storeOp: jsStoreOp,
		clearValue: color
	};
}

const getRenderPassDepthStencilAttachment = (ptr) => {
	const view_idx = getU64(ptr, 0);
	const _depthLoadOp = getU32(ptr, 8);
	const _depthStoreOp = getU32(ptr, 12);
	const depthClearValue = getF32(ptr, 16);
	const depthReadOnly = getU32(ptr, 20);
	const stencilLoadOp = getU32(ptr, 24);
	const stencilStoreOp = getU32(ptr, 28);
	const clearStencil = getU32(ptr, 32);
	const stencilReadOnly = getU32(ptr, 36);

	const view = object_map[view_idx];
	if (!view) {
		return null;
	}
	
	let jsDepthLoadOp = convertLoadOpToJs(_depthLoadOp);
	let jsDepthStoreOp = convertStoreOpToJs(_depthStoreOp);

	let jsStencilLoadOp = convertLoadOpToJs(stencilLoadOp);
	let jsStencilStoreOp = convertStoreOpToJs(stencilStoreOp);

	let obj = {
		depthClearValue,
		depthLoadOp: jsDepthLoadOp,
		depthStoreOp: jsDepthStoreOp,
		depthReadOnly: depthReadOnly != 0,
		stencilClearValue: clearStencil,
		stencilLoadOp: jsStencilLoadOp,
		stencilStoreOp: jsStencilStoreOp,
		stencilReadOnly: stencilReadOnly != 0,
		view
	};
	return obj;
}

jai_imports.jsCommandEncoderBeginRenderPass = (params_ptr, returns_ptr) => {
	const encoder_idx = getU64(params_ptr, 0);
	if (encoder_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const encoder = object_map[encoder_idx];
	if (!encoder) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const colorAttachmentCount = getU64(descriptor_ptr, 24);
	const colorAttachments_ptr = getU64(descriptor_ptr, 32);
	const depthStencilAttachment_ptr = getU64(descriptor_ptr, 40);
	const occlusionQuerySet_idx = getU64(descriptor_ptr, 48);
	const timestampWrites_ptr = getU64(descriptor_ptr, 56);

	const colorAttachments = [];
	let cursor = 0;
	for (let i = 0; i < colorAttachmentCount; i++) {
		const attachment = getRenderPassColorAttachment(colorAttachments_ptr + BigInt(cursor));
		if (!attachment) {
			console.error("Invalid color attachment in render pass descriptor");
			return;
		}
		colorAttachments.push(attachment);
		cursor += 72;
	}
	
	let depthStencilAttachment = undefined;
	if (depthStencilAttachment_ptr != 0) {
		depthStencilAttachment = getRenderPassDepthStencilAttachment(depthStencilAttachment_ptr);
		if (!depthStencilAttachment) {
			console.error("Invalid depth-stencil attachment in render pass descriptor");
			return;
		}
	}
	
	// const occlusionQuerySet = occlusionQuerySet_idx != 0 ? object_map[occlusionQuerySet_idx] : undefined;

	const jsDescriptor = {
		label,
		colorAttachments,
		depthStencilAttachment,
		// occlusionQuerySet,
	};

	const pass = encoder.beginRenderPass(jsDescriptor);
	
	object_map_counter += 1;
	object_map[object_map_counter] = pass;
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsRenderPassEncoderSetPipeline = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	const pipeline_idx = getU64(params_ptr, 8);

	if (pass_idx <= 0 || pipeline_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	const pipeline = object_map[pipeline_idx];
	if (!pass || !pipeline) {
		return;
	}

	pass.setPipeline(pipeline);
}

jai_imports.jsRenderPassEncoderDraw = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	const vertexCount = getU32(params_ptr, 8);
	const instanceCount = getU32(params_ptr, 12);
	const firstVertex = getU32(params_ptr, 16);
	const firstInstance = getU32(params_ptr, 20);

	if (pass_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	if (!pass ) {
		return;
	}

	pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
}

jai_imports.jsRenderPassEncoderEnd = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	if (pass_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	if (!pass) {
		return;
	}

	pass.end();
}

jai_imports.jsSurfaceGetCurrentTexture = (params_ptr, returns_ptr) => {
	const surface_idx = getU64(params_ptr, 0);
	if (surface_idx <= 0) {
		return;
	}
	
	const surface = object_map[surface_idx];
	if (!surface) {
		return;
	}

	const texture = surface.getContext("webgpu").getCurrentTexture();
	if (!texture) {
		return;
	}
	
	object_map_counter += 1;
	object_map[object_map_counter] = texture;
	const texture_idx = object_map_counter;
	
	setU64(returns_ptr, 0, texture_idx);
}

const convertTextureViewDimensionToJs = (dimension) => {
	if (dimension == WGPUTextureViewDimension_1D)
		return "1d";
	if (dimension == WGPUTextureViewDimension_2D)
		return "2d";
	if (dimension == WGPUTextureViewDimension_2DArray)
		return "2d-array";
	if (dimension == WGPUTextureViewDimension_Cube)
		return "cube";
	if (dimension == WGPUTextureViewDimension_CubeArray)
		return "cube-array";
	if (dimension == WGPUTextureViewDimension_3D)
		return "3d";
	return "2d";
}

const getTexureViewDescriptor = (ptr) => {
	const nextInChain_ptr = getU64(ptr, 0);
	const label = getString(ptr + 8n);
	const format = getU32(ptr, 16);
	const dimension = getU32(ptr, 20);
	const baseMipLevel = getU32(ptr, 24);
	const mipLevelCount = getU32(ptr, 28);
	const baseArrayLayer = getU32(ptr, 32);
	const arrayLayerCount = getU32(ptr, 36);
	const aspect = getU32(ptr, 40);
	const usage = getU64(ptr, 48);

	let jsFormat = undefined;
	if (format != 0) {
		jsFormat = textureFormatConvert(format);
	}

	let jsDimension = convertTextureViewDimensionToJs(dimension);
	
	let jsAspect = "all";
	if (aspect == WGPUTextureAspect_StencilOnly)
		jsAspect = "stencil-only";
	if (aspect == WGPUTextureAspect_DepthOnly)
		jsAspect = "depth-only";
	if (aspect == WGPUTextureAspect_All)
		jsAspect = "all";

	return {
		arrayLayerCount: arrayLayerCount,
		aspect: jsAspect,
		baseArrayLayer: baseArrayLayer,
		baseMipLevel: baseMipLevel,
		dimension: jsDimension,
		format: jsFormat,
		label: label,
		mipLevelCount: mipLevelCount,
		usage: usage
	};
}

jai_imports.jsTextureCreateView = (params_ptr, returns_ptr) => {
	const texture_idx = getU64(params_ptr, 0);
	if (texture_idx <= 0) {
		return;
	}

	const texture = object_map[texture_idx];
	if (!texture) {
		return;
	}
	
	let jsDescriptor = undefined;
	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr != 0) {
		jsDescriptor = getTexureViewDescriptor(descriptor_ptr);
	}

	object_map_counter += 1;
	object_map[object_map_counter] = texture.createView(jsDescriptor);
	const view_idx = object_map_counter;
	setU64(returns_ptr, 0, view_idx);
}

jai_imports.jsTextureViewRelease = (params_ptr, returns_ptr) => {
	const view_idx = getU64(params_ptr, 0);
	if (view_idx <= 0) {
		return;
	}
	
	object_map[view_idx] = null;
}

jai_imports.jsRenderPassEncoderRelease = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	if (pass_idx <= 0) {
		return;
	}

	object_map[pass_idx] = null;
}

jai_imports.jsSurfacePresent = (params_ptr, returns_ptr) => {
	const surface_idx = getU64(params_ptr, 0);
	if (surface_idx <= 0) {
		return;
	}
	
	const surface = object_map[surface_idx];
	if (!surface) {
		return;
	}

	const vsync = true;
	if (wasm_pause() === 0) {
		const render_and_resume = () => {
			wasm_resume(1);
		};
		
		if (vsync) requestAnimationFrame(render_and_resume);
		else       setTimeout(render_and_resume, 0);
	}
}

jai_imports.jsTextureGetFormat = (params_ptr, returns_ptr) => {
	const texture_idx = getU64(params_ptr, 0);

	if (texture_idx <= 0) {
		return;
	}
	
	const texture = object_map[texture_idx];
	if (!texture) {
		return;
	}
	
	const format = textureFormatReverseConvert(texture.format);
	setU32(returns_ptr, 0, format);
}

const convertBufferTypeToJs = (type) => {
	if (type == WGPUBufferBindingType_Uniform)
		return "uniform";
	if (type == WGPUBufferBindingType_Storage)
		return "storage";
	if (type == WGPUBufferBindingType_ReadOnlyStorage)
		return "read-only-storage";
	return "uniform";
}

const convertSamplerBindingTypeToJs = (type) => {
	if (type == WGPUSamplerBindingType_Filtering)
		return "filtering";
	if (type == WGPUSamplerBindingType_NonFiltering)
		return "non-filtering";
	if (type == WGPUSamplerBindingType_Comparison)
		return "comparison";
	return "filtering";
}

const convertTextureSampleTypeToJs = (type) => {
	if (type == WGPUTextureSampleType_Float)
		return "float";
	if (type == WGPUTextureSampleType_UnfilterableFloat)
		return "unfilterable-float";
	if (type == WGPUTextureSampleType_Depth)
		return "depth";
	if (type == WGPUTextureSampleType_Sint)
		return "sint";
	if (type == WGPUTextureSampleType_Uint)
		return "uint";
	return "float";
}

const convertStorageTextureAccessToJs = (access) => {
	if (access == WGPUStorageTextureAccess_WriteOnly)
		return "write-only";
	if (access == WGPUStorageTextureAccess_ReadOnly)
		return "read-only";
	if (access == WGPUStorageTextureAccess_ReadWrite)
		return "read-write";
	return "write-only";
}


const getBindGroupLayoutEntry = (ptr) => {
	const binding = getU32(ptr, 8);
	const visibility = getU64(ptr, 16);
	const bufferType = getU32(ptr, 24 + 8);
	const hasDynamicOffset = getU32(ptr, 24 + 12);
	const minBindingSize = getU32(ptr, 24 + 16);
	const samplerRaw = getU32(ptr, 48 + 8);
	const textureSampleTypeRaw = getU32(ptr, 64 + 8);
	const textureViewDimensionRaw = getU32(ptr, 64 + 12);
	const textureMultisampled = getU32(ptr, 64 + 16);
	const storageTextureAccess = getU32(ptr, 88 + 8);
	const storageTextureFormatRaw = getU32(ptr, 88 + 12);
	const storageTextureViewDimension = getU32(ptr, 88 + 16);

	let obj = {};
	obj.binding = binding;
	obj.visibility = Number(visibility);
	
	obj.buffer = undefined;
	if (bufferType != 0) {
		obj.buffer = {
			type: convertBufferTypeToJs(bufferType),
			hasDynamicOffset: hasDynamicOffset != 0,
			minBindingSize: minBindingSize
		};
	}
	
	obj.sampler = undefined;
	if (samplerRaw != 0) {
		obj.sampler = {
			type: convertSamplerBindingTypeToJs(samplerRaw)
		};
	}
	
	obj.texture = undefined;
	if (textureSampleTypeRaw != 0) {
		obj.texture = {
			sampleType: convertTextureSampleTypeToJs(textureSampleTypeRaw),
			viewDimension: convertTextureViewDimensionToJs(textureViewDimensionRaw),
			multisampled: textureMultisampled != 0
		};
	}
	
	obj.storageTexture = undefined;
	if (storageTextureAccess != 0 && storageTextureFormatRaw != 0) {
		obj.storageTexture = {
			access: convertStorageTextureAccessToJs(storageTextureAccess),
			format: textureFormatConvert(storageTextureFormatRaw),
			viewDimension: convertTextureViewDimensionToJs(storageTextureViewDimension)
		};
	}

	return obj;
}

jai_imports.jsDeviceCreateBindGroupLayout = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}
	
	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const entryCount = getU64(descriptor_ptr, 24);
	const entries_ptr = getU64(descriptor_ptr, 32);

	const entries = [];
	let cursor = 0;
	for (let i = 0; i < entryCount; i++) {
		entries.push(getBindGroupLayoutEntry(Number(entries_ptr) + Number(cursor)));
		cursor += 112;
	}

	object_map_counter += 1;
	object_map[object_map_counter] = device.createBindGroupLayout({
		label,
		entries
	});
	
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsBindGroupLayoutRelease = (params_ptr, returns_ptr) => {
	const layout_idx = getU64(params_ptr, 0);
	if (layout_idx <= 0) {
		return;
	}

	object_map[layout_idx] = null;
}

const getBindGroupEntry = (ptr) => {
	const binding = getU32(ptr, 8);
	const buffer_idx = getU64(ptr, 16);
	const offset = getU64(ptr, 24);
	const size = getU64(ptr, 32);
	const sampler_idx = getU64(ptr, 40);
	const textureView_idx = getU64(ptr, 48);

	let obj = {};
	obj.binding = binding;

	if (buffer_idx != 0) {
		const buffer = object_map[buffer_idx];
		if (!buffer) {
			return null;
		}
		obj.resource = {
			buffer,
			offset: Number(offset),
			size: Number(size)
		};
	}

	if (sampler_idx != 0) {
		const sampler = object_map[sampler_idx];
		if (!sampler) {
			return null;
		}
		obj.resource = sampler;
	}

	if (textureView_idx != 0) {
		const textureView = object_map[textureView_idx];
		if (!textureView) {
			return null;
		}
		obj.resource = textureView;
	}

	return obj;
}

jai_imports.jsDeviceCreateBindGroup = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}
	
	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const layout_idx = getU64(descriptor_ptr, 24);
	const entryCount = getU64(descriptor_ptr, 32);
	const entries_ptr = getU64(descriptor_ptr, 40);
	
	const layout = object_map[layout_idx];
	if (!layout) {
		return;
	}
	
	const entries = [];
	let cursor = 0;
	for (let i = 0; i < entryCount; i++) {
		entries.push(getBindGroupEntry(Number(entries_ptr) + Number(cursor)));
		cursor += 56;
	}
	
	object_map_counter += 1;
	object_map[object_map_counter] = device.createBindGroup({
		label,
		layout,
		entries
	});
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsBindGroupRelease = (params_ptr, returns_ptr) => {
	const group_idx = getU64(params_ptr, 0);
	if (group_idx <= 0) {
		return;
	}

	object_map[group_idx] = null;
}

jai_imports.jsRenderPipelineGetBindGroupLayout = (params_ptr, returns_ptr) => {
	const pipeline_idx = getU64(params_ptr, 0);
	if (pipeline_idx <= 0) {
		return;
	}
	
	const index = getU32(params_ptr, 8);

	const pipeline = object_map[pipeline_idx];
	if (!pipeline) {
		return;
	}

	const layout = pipeline.getBindGroupLayout(index);
	if (!layout) {
		return;
	}

	object_map_counter += 1;
	object_map[object_map_counter] = layout;
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsRenderPassEncoderSetBindGroup = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	const index = getU64(params_ptr, 8);
	const group_idx = getU64(params_ptr, 16);
	const dynamicOffsetCount = getU64(params_ptr, 24);
	const dynamicOffsets_ptr = getU64(params_ptr, 32);

	if (pass_idx <= 0 || group_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	const group = object_map[group_idx];
	if (!pass || !group) {
		return;
	}

	const dynamicOffsets = [];
	let cursor = 0;
	for (let i = 0; i < dynamicOffsetCount; i++) {
		dynamicOffsets.push(getU32(dynamicOffsets_ptr, cursor));
		cursor += 4;
	}

	pass.setBindGroup(Number(index), group, dynamicOffsets);
}

jai_imports.jsRenderPassEncoderSetVertexBuffer = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	const slot = getU32(params_ptr, 8);
	const buffer_idx = getU64(params_ptr, 16);
	const offset = getU64(params_ptr, 24);
	const size = getU64(params_ptr, 32);

	if (pass_idx <= 0 || buffer_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	const buffer = object_map[buffer_idx];
	if (!pass || !buffer) {
		return;
	}

	if (size != 0) {
		pass.setVertexBuffer(slot, buffer, Number(offset), Number(size));
	} else if (offset != 0) {
		pass.setVertexBuffer(slot, buffer, Number(offset));
	} else {
		pass.setVertexBuffer(slot, buffer);
	}
}

jai_imports.jsDeviceCreateTexture = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}
	
	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const nextInChain_ptr = getU64(descriptor_ptr, 0);
	const label = getString(descriptor_ptr + 8n);
	const usage = getU64(descriptor_ptr, 24);
	const dimensionRaw = getU32(descriptor_ptr, 32);
	const sizeWidth = getU32(descriptor_ptr, 36);
	const sizeHeight = getU32(descriptor_ptr, 40);
	const sizeDepthOrArrayLayers = getU32(descriptor_ptr, 44);
	const formatRaw = getU32(descriptor_ptr, 48);
	const mipLevelCount = getU32(descriptor_ptr, 52);
	const sampleCount = getU32(descriptor_ptr, 56);
	const viewFormatCount = getU32(descriptor_ptr, 64);
	const viewFormats_ptr = getU64(descriptor_ptr, 72);

	let format = undefined;
	if (formatRaw != 0) {
		format = textureFormatConvert(formatRaw);
	}

	let dimension = convertTextureDimensionToJs(dimensionRaw);

	const viewFormats = [];
	let cursor = 0;
	for (let i = 0; i < viewFormatCount; i++) {
		const vfRaw = getU32(viewFormats_ptr, cursor);
		viewFormats.push(textureFormatConvert(vfRaw));
		cursor += 4;
	}

	const jsDescriptor = {
		label,
		size: {
			width: sizeWidth,
			height: sizeHeight,
			depthOrArrayLayers: sizeDepthOrArrayLayers
		},
		mipLevelCount,
		sampleCount,
		dimension,
		format,
		usage: Number(usage),
		viewFormats
	};
	
	object_map_counter += 1;
	object_map[object_map_counter] = device.createTexture(jsDescriptor);
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsTextureRelease = (params_ptr, returns_ptr) => {
	const texture_idx = getU64(params_ptr, 0);
	if (texture_idx <= 0) {
		return;
	}

	object_map[texture_idx] = null;
}

jai_imports.jsDeviceCreateSampler = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}
	
	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const nextInChain_ptr = getU64(descriptor_ptr, 0);
	const label = getString(descriptor_ptr + 8n);
	const addressModeURaw = getU32(descriptor_ptr, 24);
	const addressModeVRaw = getU32(descriptor_ptr, 28);
	const addressModeWRaw = getU32(descriptor_ptr, 32);
	const magFilterRaw = getU32(descriptor_ptr, 36);
	const minFilterRaw = getU32(descriptor_ptr, 40);
	const mipmapFilterRaw = getU32(descriptor_ptr, 44);
	const lodMinClamp = getF32(descriptor_ptr, 48);
	const lodMaxClamp = getF32(descriptor_ptr, 52);
	const compareRaw = getU32(descriptor_ptr, 56);
	const maxAnisotropy = getU32(descriptor_ptr, 60);

	const addressModeU = convertAddressModeToJs(addressModeURaw);
	const addressModeV = convertAddressModeToJs(addressModeVRaw);
	const addressModeW = convertAddressModeToJs(addressModeWRaw);

	const magFilter = convertFilterModeToJs(magFilterRaw);
	const minFilter = convertFilterModeToJs(minFilterRaw);
	const mipmapFilter = convertFilterModeToJs(mipmapFilterRaw);
	const compare = convertCompareFunctionToJs(compareRaw);

	let jsDescriptor = {
		label,
		addressModeU,
		addressModeV,
		addressModeW,
		magFilter,
		minFilter,
		mipmapFilter,
		lodMinClamp,
		lodMaxClamp,
		maxAnisotropy
	};
	if (compareRaw > 0) {
		jsDescriptor = {
			compare
		};
	}

	object_map_counter += 1;
	object_map[object_map_counter] = device.createSampler(jsDescriptor);
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsSamplerRelease = (params_ptr, returns_ptr) => {
	const sampler_idx = getU64(params_ptr, 0);
	if (sampler_idx <= 0) {
		return;
	}

	object_map[sampler_idx] = null;
}

jai_imports.jsDeviceCreatePipelineLayout = (params_ptr, returns_ptr) => {
	const device_idx = getU64(params_ptr, 0);
	if (device_idx <= 0) {
		return;
	}

	const descriptor_ptr = getU64(params_ptr, 8);
	if (descriptor_ptr == 0) {
		return;
	}

	const device = object_map[device_idx];
	if (!device) {
		return;
	}

	const label = getString(descriptor_ptr + 8n);
	const bindGroupLayoutCount = getU64(descriptor_ptr, 24);
	const bindGroupLayouts_ptr = getU64(descriptor_ptr, 32);

	const bindGroupLayouts = [];
	let cursor = 0;
	for (let i = 0; i < bindGroupLayoutCount; i++) {
		const bgl_idx = getU64(bindGroupLayouts_ptr, cursor);
		cursor += 8;

		const bgl = object_map[bgl_idx];
		if (!bgl) {
			console.error("Invalid bind group layout in pipeline layout descriptor");
			return;
		}
		bindGroupLayouts.push(bgl);
	}

	object_map_counter += 1;
	object_map[object_map_counter] = device.createPipelineLayout({
		label,
		bindGroupLayouts
	});
	
	setU64(returns_ptr, 0, object_map_counter);
}

jai_imports.jsPipelineLayoutRelease = (params_ptr, returns_ptr) => {
	const layout_idx = getU64(params_ptr, 0);
	if (layout_idx <= 0) {
		return;
	}

	object_map[layout_idx] = null;
}

jai_imports.jsRenderPassEncoderSetViewport = (params_ptr, returns_ptr) => {
	const pass_idx = getU64(params_ptr, 0);
	const x = getF32(params_ptr, 8);
	const y = getF32(params_ptr, 12);
	const width = getF32(params_ptr, 16);
	const height = getF32(params_ptr, 20);
	const minDepth = getF32(params_ptr, 24);
	const maxDepth = getF32(params_ptr, 28);

	if (pass_idx <= 0) {
		return;
	}

	const pass = object_map[pass_idx];
	if (!pass) {
		return;
	}

	pass.setViewport(x, y, width, height, minDepth, maxDepth);
}





//IO
const Key_A = 0;
const Key_B = 1;
const Key_C = 2;
const Key_D = 3;
const Key_E = 4;
const Key_F = 5;
const Key_G = 6;
const Key_H = 7;
const Key_I = 8;
const Key_J = 9;
const Key_K = 10;
const Key_L = 11;
const Key_M = 12;
const Key_N = 13;
const Key_O = 14;
const Key_P = 15;
const Key_Q = 16;
const Key_R = 17;
const Key_S = 18;
const Key_T = 19;
const Key_U = 20;
const Key_V = 21;
const Key_W = 22;
const Key_X = 23;
const Key_Y = 24;
const Key_Z = 25;
const Key__0 = 26;
const Key__1 = 27;
const Key__2 = 28;
const Key__3 = 29;
const Key__4 = 30;
const Key__5 = 31;
const Key__6 = 32;
const Key__7 = 33;
const Key__8 = 34;
const Key__9 = 35;
const Key_Space = 36;
const Key_F1 = 37;
const Key_F2 = 38;
const Key_F3 = 39;
const Key_F4 = 40;
const Key_F5 = 41;
const Key_F6 = 42;
const Key_F7 = 43;
const Key_F8 = 44;
const Key_F9 = 45;
const Key_F10 = 46;
const Key_F11 = 47;
const Key_F12 = 48;
const Key_MouseLeft = 49;
const Key_MouseRight = 50;
const Key_MouseMiddle = 51;

let key_buffer = [];

let mouse_x = 0;
let mouse_y = 0;

const mapKeyNameToKeyIndex = (e) => {
	const lowered = e.toLowerCase();
	switch (lowered) {
		case "a": return Key_A;
		case "b": return Key_B;
		case "c": return Key_C;
		case "d": return Key_D;
		case "e": return Key_E;
		case "f": return Key_F;
		case "g": return Key_G;
		case "h": return Key_H;
		case "i": return Key_I;
		case "j": return Key_J;
		case "k": return Key_K;
		case "l": return Key_L;
		case "m": return Key_M;
		case "n": return Key_N;
		case "o": return Key_O;
		case "p": return Key_P;
		case "q": return Key_Q;
		case "r": return Key_R;
		case "s": return Key_S;
		case "t": return Key_T;
		case "u": return Key_U;
		case "v": return Key_V;
		case "w": return Key_W;
		case "x": return Key_X;
		case "y": return Key_Y;
		case "z": return Key_Z;
		case "0": return Key__0;
		case "1": return Key__1;
		case "2": return Key__2;
		case "3": return Key__3;
		case "4": return Key__4;
		case "5": return Key__5;
		case "6": return Key__6;
		case "7": return Key__7;
		case "8": return Key__8;
		case "9": return Key__9;
		case " ": return Key_Space;
		case "f1": return Key_F1;
		case "f2": return Key_F2;
		case "f3": return Key_F3;
		case "f4": return Key_F4;
		case "f5": return Key_F5;
		case "f6": return Key_F6;
		case "f7": return Key_F7;
		case "f8": return Key_F8;
		case "f9": return Key_F9;
		case "f10": return Key_F10;
		case "f11": return Key_F11;
		case "f12": return Key_F12;
		default: return -1;
	}

};

document.addEventListener("keydown", (e) => {
	const keyIndex = mapKeyNameToKeyIndex(e.key);
	if (keyIndex !== -1) {
		key_buffer[keyIndex] = true;
	}
});

document.addEventListener("keyup", (e) => {
	const keyIndex = mapKeyNameToKeyIndex(e.key);
	if (keyIndex !== -1) {
		key_buffer[keyIndex] = false;
	}
});

document.addEventListener("mousedown", (e) => {
	if (e.button === 0) {
		key_buffer[Key_MouseLeft] = true;
	} else if (e.button === 1) {
		key_buffer[Key_MouseMiddle] = true;
	} else if (e.button === 2) {
		key_buffer[Key_MouseRight] = true;
	}
});

document.addEventListener("mouseup", (e) => {
	if (e.button === 0) {
		key_buffer[Key_MouseLeft] = false;
	} else if (e.button === 1) {
		key_buffer[Key_MouseMiddle] = false;
	} else if (e.button === 2) {
		key_buffer[Key_MouseRight] = false;
	}
});

document.addEventListener("mousemove", (e) => {
	const canvas = document.getElementById("webgpu-canvas");
	if (!canvas) {
		return;
	}
	const rect = canvas.getBoundingClientRect();
	mouse_x = e.clientX - rect.left;
	mouse_y = e.clientY - rect.top;
});

jai_imports.jsGetKeyState = (key_map_ptr, key_map_count) => {
	for (let i = 0; i < key_map_count; i++) {
		const index = key_buffer[i] ? 1 : 0;
		setU8(key_map_ptr, i, index);
	}
}

jai_imports.jsGetMousePointer = (x_ptr, y_ptr) => {
	setU32(x_ptr, 0, mouse_x);
	setU32(y_ptr, 0, mouse_y);
}

jai_imports.jsGetDimensions = (dim_ptr) => {
	const canvas = document.getElementById("webgpu-canvas");
	if (!canvas) {
		setU32(dim_ptr, 0, 0);
		setU32(dim_ptr, 4, 0);
		setU32(dim_ptr, 8, 0);
		setU32(dim_ptr, 12, 0);
		return;
	}
	setU32(dim_ptr, 0, canvas.x);
	setU32(dim_ptr, 4, canvas.y);
	setU32(dim_ptr, 8, canvas.width);
	setU32(dim_ptr, 12, canvas.height);
}



//SOUND
let audio_id_to_buffer = {};
let audio_id_counter = 0;

let sound_id_to_sound = {};
let sound_id_counter = 0;

let sound_id_to_state = {};
const SOUND_PLAYING = 1;
const SOUND_STOPPED = 2;

const blobToAudioBuffer = async (blob) => {
	const buffer = await blob.arrayBuffer();
	return await audio_context.decodeAudioData(buffer);
}

jai_imports.js_load_audio = (params_ptr) => {
	const data = getU64(params_ptr, 0);
	const size = getU64(params_ptr, 8);
	const id_ptr = getU64(params_ptr, 16);
	const compressed = getU64(params_ptr, 24) != 0;

	switch (wasm_pause()) {
		case 0: (async () => {
			const array = new Uint8Array(jai_exports.memory.buffer, Number(data), Number(size));
			const buffer = await blobToAudioBuffer(new Blob([array]));

			audio_id_counter += 1;
			const audio_id = audio_id_counter;
			audio_id_to_buffer[audio_id] = buffer;

			setU64(id_ptr, 0, audio_id);
			return +1;
		})().then(wasm_resume); break;
	}
}

jai_imports.js_play_audio = (params_ptr) => {
	const id = getU64(params_ptr, 0);
	const x = getF32(params_ptr, 8);
	const y = getF32(params_ptr, 12);
	const z = getF32(params_ptr, 16);
	const volume = getF32(params_ptr, 20);
	const pitch = getF32(params_ptr, 24);
	let loop = getU32(params_ptr, 28) != 0;
	const kind = getS32(params_ptr, 32);
	const fade_in = getS32(params_ptr, 36);
	const sound_id_ptr = getU64(params_ptr, 40);

	const buffer = audio_id_to_buffer[id];
	if (!buffer) {
		console.error(`Audio buffer with id ${id} not found`);
		setU64(sound_id_ptr, 0, 0);
		return;
	}

	const source = audio_context.createBufferSource();
	source.buffer = buffer;
	source.loop = loop;
	// source.playbackRate.value = pitch;
	
	const gainNode = audio_context.createGain();
	gainNode.gain.setValueAtTime(0, audio_context.currentTime);
	gainNode.gain.linearRampToValueAtTime(volume, audio_context.currentTime + fade_in / 1000);
	
	let panner = null;
	if (kind == 0) {
		panner = audio_context.createPanner();
		panner.panningModel = 'equalpower';
		panner.distanceModel = 'exponential';
		panner.refDistance = 1.0;
		panner.maxDistance = 1000;
		panner.rolloffFactor = 3.0;
		panner.setPosition(x, y, z);
		
		source.connect(gainNode);
		gainNode.connect(panner);
		panner.connect(audio_context.destination);
	} else {
		// no spatialization
		source.connect(gainNode);
		gainNode.connect(audio_context.destination);
	}
	
	source.start(0);
	
	sound_id_counter += 1;
	const sound_id = sound_id_counter;
	sound_id_to_sound[sound_id] = {
		source,
		gainNode,
		panner,
		audio_id: id,
	};
	sound_id_to_state[sound_id] = SOUND_PLAYING;
	
	source.onended = () => {
		delete sound_id_to_sound[sound_id];
		sound_id_to_state[sound_id] = SOUND_STOPPED;
	};

	setU64(sound_id_ptr, 0, sound_id);
}

jai_imports.js_query_sound = (params_ptr) => {
	const sound_idx = getU64(params_ptr, 0);
	const audio_id_ptr = getU64(params_ptr, 8);
	const x_ptr = getU64(params_ptr, 16);
	const y_ptr = getU64(params_ptr, 24);
	const z_ptr = getU64(params_ptr, 32);
	const volume_ptr = getU64(params_ptr, 40);
	const pitch_ptr = getU64(params_ptr, 48);
	const playing_ptr = getU64(params_ptr, 56);
	const looping_ptr = getU64(params_ptr, 64);

	const sound = sound_id_to_sound[sound_idx];
	if (!sound) {
		setU64(audio_id_ptr, 0, 0);
		setF32(x_ptr, 0, 0);
		setF32(y_ptr, 0, 0);
		setF32(z_ptr, 0, 0);
		setF32(volume_ptr, 0, 0);
		setF32(pitch_ptr, 0, 0);
		setU32(playing_ptr, 0, 0);
		setU32(looping_ptr, 0, 0);
		return;
	}

	let source = sound.source;
	let gainNode = sound.gainNode;
	let panner = sound.panner;
	const audio_id = sound.audio_id;

	const pos = [0, 0, 0];
	if (panner) {
		pos[0] = panner.positionX.value;
		pos[1] = panner.positionY.value;
		pos[2] = panner.positionZ.value;
	}
	const volume = gainNode.gain.value;
	const rate = source.playbackRate.value;
	const playing = sound_id_to_state[sound_id] === SOUND_PLAYING ? 1 : 0;
	const looping = source.loop ? 1 : 0;

	setU64(audio_id_ptr, 0, audio_id);
	setF32(x_ptr, 0, pos[0]);
	setF32(y_ptr, 0, pos[1]);
	setF32(z_ptr, 0, pos[2]);
	setF32(volume_ptr, 0, volume);
	setF32(pitch_ptr, 0, rate);
	setU32(playing_ptr, 0, playing);
	setU32(looping_ptr, 0, looping);
}

jai_imports.js_set_sound = (params_ptr) => {
	const sound_idx = getU64(params_ptr, 0);
	const x = getF32(params_ptr, 8);
	const y = getF32(params_ptr, 12);
	const z = getF32(params_ptr, 16);
	const volume = getF32(params_ptr, 20);
	const pitch = getF32(params_ptr, 24);
	const playing = getU32(params_ptr, 28);
	const looping = getU32(params_ptr, 32);

	const sound = sound_id_to_sound[sound_idx];
	if (!sound) {
		return;
	}

	let source = sound.source;
	let gainNode = sound.gainNode;
	let panner = sound.panner;
	
	if (panner) {
		panner.positionX.value = x;
		panner.positionY.value = y;
		panner.positionZ.value = z;
	}
	gainNode.gain.value = volume;
	// source.playbackRate.value = pitch;

	const is_sound_playing = sound_id_to_state[sound_idx] === SOUND_PLAYING;
	if (playing) {
		if (!is_sound_playing) {
			source.start(0);
			sound_id_to_state[sound_idx] = SOUND_PLAYING;
		}
	} else {
		if (is_sound_playing) {
			source.stop(0);
			sound_id_to_state[sound_idx] = SOUND_STOPPED;
		}
	}
	source.loop = looping != 0;

}

jai_imports.js_set_listener_info = (params_ptr) => {
	const x = getF32(params_ptr, 0);
	const y = getF32(params_ptr, 4);
	const z = getF32(params_ptr, 8);
	const forward_x = getF32(params_ptr, 12);
	const forward_y = getF32(params_ptr, 16);
	const forward_z = getF32(params_ptr, 20);

	audio_context.listener.positionX.value = x;
	audio_context.listener.positionY.value = y;
	audio_context.listener.positionZ.value = z;
	audio_context.listener.forwardX.value = forward_x;
	audio_context.listener.forwardY.value = forward_y;
	audio_context.listener.forwardZ.value = forward_z;
	audio_context.listener.upX.value = 0;
	audio_context.listener.upY.value = 0;
	audio_context.listener.upZ.value = 1;
}

