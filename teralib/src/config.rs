use once_cell::sync::Lazy;
use serde_json::Value;

const CONFIG: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/config/config.json"
));

static CONFIG_JSON: Lazy<Value> =
    Lazy::new(|| serde_json::from_str(CONFIG).expect("Failed to parse config"));

pub fn get_config_value(key: &str) -> String {
    CONFIG_JSON[key]
        .as_str()
        .unwrap_or_else(|| panic!("{} must be set in config.json", key))
        .to_string()
}
