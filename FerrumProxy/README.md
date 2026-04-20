# FerrumProxy

Rust implementation of BunProxy.

FerrumProxy lives beside the Bun/TypeScript implementation and aims to match the same public behavior while keeping the network hot path in Rust.

## Build

With Cargo:

```bash
cargo build --release
```

With CMake as a wrapper around Cargo:

```bash
cmake -S . -B build
cmake --build build --config Release
```

The binary is created under `target/release/`.

## Cross-Platform Build Output

Local helper scripts copy finished binaries into `target/build/<platform>/`.

PowerShell:

```powershell
.\scripts\build-all.ps1
```

Bash:

```bash
./scripts/build-all.sh
```

Default platforms:

- `target/build/windows-x64/ferrum-proxy.exe`
- `target/build/linux-x64/ferrum-proxy`
- `target/build/linux-arm64/ferrum-proxy`
- `target/build/macos-x64/ferrum-proxy`
- `target/build/macos-arm64/ferrum-proxy`

Cross-compiling every target from one local OS may require extra linkers or SDKs. The GitHub Actions workflow uses native hosted runners for each OS and uploads each platform binary as an artifact.

## Run

```bash
./target/release/ferrum-proxy
```

On Windows:

```powershell
.\target\release\ferrum-proxy.exe
```

## Implemented BunProxy Behavior

- YAML config with `endpoint`, `useRestApi`, `savePlayerIP`, `debug`, and `listeners`
- TCP forwarding
- UDP forwarding
- HAProxy PROXY protocol v2 parse/build for TCP and UDP
- DNS cache for target hostnames
- Bedrock `Unconnected Pong` advertised port rewrite
- Short shared Bedrock pong cache for reducing backend ping load
- HTTPS listener/TLS termination with manual cert paths or Linux Let's Encrypt auto-detection
- URL-style HTTP/HTTPS targets with request path/host rewrite and response `Location` rewrite
- HTTPS backend connections for `https://...` URL targets
- Discord webhook grouped connection/disconnection notifications
- REST management API for `/api/login`, `/api/logout`, and `/api/players`
- Player connection buffering and player IP persistence in `playerIP.json`
- Debug logging via `debug: true`

## Notes

FerrumProxy intentionally keeps the same config shape as BunProxy where possible. Some internal implementation details differ because Rust uses Tokio tasks and Rustls instead of Bun/Node sockets.

If `config.yml` does not exist in the current working directory, FerrumProxy creates a default one automatically. Use `--config <path>` only when you want to load another file.

---

# FerrumProxy (日本語)

BunProxy の Rust 実装です。

FerrumProxy は Bun/TypeScript 実装のそばに置き、外から見た挙動を BunProxy に合わせつつ、ネットワークのホットパスを Rust で処理することを目的にしています。

## ビルド

Cargo で:

```bash
cargo build --release
```

Cargo のラッパーとして CMake を使う場合:

```bash
cmake -S . -B build
cmake --build build --config Release
```

バイナリは `target/release/` 以下に作成されます。

## クロスプラットフォーム出力

ローカル用ヘルパースクリプトは、完成したバイナリを `target/build/<platform>/` にコピーします。

PowerShell:

```powershell
.\scripts\build-all.ps1
```

Bash:

```bash
./scripts/build-all.sh
```

既定の出力先:

- `target/build/windows-x64/ferrum-proxy.exe`
- `target/build/linux-x64/ferrum-proxy`
- `target/build/linux-arm64/ferrum-proxy`
- `target/build/macos-x64/ferrum-proxy`
- `target/build/macos-arm64/ferrum-proxy`

1つのローカル OS から全ターゲットをクロスコンパイルするには、追加の linker や SDK が必要になる場合があります。GitHub Actions では各 OS の hosted runner を使って、それぞれの platform binary を artifact としてアップロードします。

## 実行

```bash
./target/release/ferrum-proxy
```

Windows の場合:

```powershell
.\target\release\ferrum-proxy.exe
```

## BunProxy 互換機能

- `endpoint`, `useRestApi`, `savePlayerIP`, `debug`, `listeners` を含む YAML config
- TCP 転送
- UDP 転送
- TCP/UDP の HAProxy PROXY protocol v2 パース/生成
- ターゲットホスト名の DNS キャッシュ
- Bedrock `Unconnected Pong` の advertised port 書き換え
- backend ping 負荷を減らす短時間共有 Bedrock pong キャッシュ
- 手動証明書または Linux Let's Encrypt 自動検出による HTTPS 待受/TLS 終端
- URL形式 HTTP/HTTPS ターゲットの request path/host rewrite と response `Location` rewrite
- `https://...` URL ターゲットへの HTTPS backend 接続
- Discord webhook の接続/切断グループ通知
- `/api/login`, `/api/logout`, `/api/players` REST 管理 API
- プレイヤー接続バッファと `playerIP.json` への IP 保存
- `debug: true` によるデバッグログ

## 補足

設定形式は可能な範囲で BunProxy と同じです。内部実装は Bun/Node socket ではなく Tokio task と Rustls を使うため、細部は Rust 向けに調整しています。

カレントディレクトリに `config.yml` が無い場合、FerrumProxy は既定の設定ファイルを自動生成します。別の設定ファイルを使いたい場合だけ `--config <path>` を指定してください。
