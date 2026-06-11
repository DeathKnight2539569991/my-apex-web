# Apex 数据画像

一个面向 Apex 单局数据截图的趣味数据网站。v1 只做数据画像，不做“区”的最终判定。

## 功能

- 上传中文 Apex 数据截图，使用 OCR 预填字段。
- 手动校对玩家 ID、击杀、助攻、击倒、伤害量、存活时间。
- 计算单局 DPM、伤害人头比、击倒转化率、纯击倒。
- 按玩家 ID 查询和保存云端历史数据。
- 展示场均核心数据、历史效率、近期趋势、个人 vs 网站平均雷达图。

## 本地开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm run typecheck
npm run test
npm run build
```

## 部署

Vercel 默认配置即可：

- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`

云端数据使用 Vercel KV 或 Upstash Redis REST。需要配置以下任意一组环境变量：

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

或：

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```
