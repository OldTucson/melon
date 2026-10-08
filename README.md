# Pattern Library

面向图案设计师的私有 Web 图案资料库，使用 Next.js 和阿里云 OSS 管理 PSD、AI、JPG、PNG 与 Procreate 原文件。

当前状态：设计评审阶段，尚未开始应用脚手架和功能实现。

## 文档

- [产品与技术设计](docs/superpowers/specs/2026-10-08-pattern-library-web-design.md)

## 已确认方向

- 纯 Web，Mac 桌面浏览器优先，后续适配 iPad 和 iPhone 网页。
- Next.js 全栈单体、PostgreSQL、私有阿里云 OSS。
- 浏览器直传 OSS，支持分片进度、取消和重选文件续传。
- 支持预览、下载、标签、筛选、离线元数据与标签同步。
- 私有账号体系，不开放公开注册。
