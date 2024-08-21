fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=src/serverlist.proto");
    
    let out_dir = std::env::var("OUT_DIR").unwrap();
    println!("OUT_DIR: {}", out_dir);

    match prost_build::compile_protos(&["src/serverlist.proto"], &["src/"]) {
        Ok(_) => println!("Proto compilation successful"),
        Err(e) => println!("Proto compilation failed: {:?}", e),
    }

    Ok(())
}