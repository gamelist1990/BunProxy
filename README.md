# bun-proxy

YAML設定ファイルを使用したBunベースのTCP/UDPフォワーダー。

使用方法:

- Bunがインストールされていることを確認してください。
- 依存関係（TypeScript/Nodeタイプを含む）をインストールし、実行します:
```
bun install
bun index.ts
```
または `bun run start`。
- 初回実行時に、同じディレクトリに `config.yml` が生成され、サンプルルールが含まれます。

設定例:

```yaml
listeners:
  - bind: "0.0.0.0"
    tcp: 8000
    udp: 8001
    haproxy: false
    target:
      host: "127.0.0.1"
      tcp: 9000
      udp: 9001
```

これは、0.0.0.0:8000でTCPをリッスンし、127.0.0.1:9000にプロキシし、同様にUDP 8001 -> 9001を行います。

注意: リスナールールで `haproxy: true` を設定することで、HAProxy PROXY Protocol v2を有効にできます。
有効にすると、プロキシは各TCP接続**および**クライアントセッションごとの最初のUDPパケットに対してPROXY v2ヘッダーを送信します。宛先はPROXY Protocol v2をサポートする必要があります。


## Download

ダウンロードは[リリースページ](https://github.com/gamelist1990/BunProxy/releases)にあるので、そこから最新のビルドをダウンロードしてください。



## 使い方 (動画)

[![Youtube](https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg)](https://www.youtube.com/watch?v=VIDEO_ID)