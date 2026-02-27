# City Pulse 🏙️

城市生活指标追踪 - 自动采集、可视化展示

## 功能

- 自动采集上海房价数据（每日更新）
- 静态网站展示趋势
- 托管在 GitHub Pages

## 数据来源

数据来自公开网站，仅供参考。

## 本地开发

```bash
# 安装依赖
npm install

# 运行数据采集
node scripts/fetch.js

# 本地预览网站
npx serve .
```

## 自动更新

通过 GitHub Actions 每天自动采集数据并更新网站。

## License

MIT
