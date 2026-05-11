//! Logging primitives for the wasm core.
//!
//! Mirrors the macro surface (`log_error!`, `log_warn!`, `log_info!`) of the
//! ump native crate, but writes through `console.log` instead of a file so
//! the same `crate::midi::*` sources port without modification.

use wasm_bindgen::JsValue;

#[doc(hidden)]
pub fn write_log(level: &str, msg: &str) {
    web_sys::console::log_1(&JsValue::from_str(&format!("[{level}] {msg}")));
}

/// Verbose flag toggle. Currently always-on; reserved for later UI control.
pub fn is_verbose() -> bool {
    true
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::debug::write_log("ERROR", &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::debug::write_log("WARN", &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        if $crate::debug::is_verbose() {
            $crate::debug::write_log("INFO", &format!($($arg)*))
        }
    };
}
