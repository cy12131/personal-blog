# 陈越的技术博客

个人技术博客，用于记录 C++、Linux、网络编程、服务器开发、项目实践与学习过程。

项目基于 Astro 构建，当前保持纯静态输出。

## 本地开发

```sh
npm install
npm run dev
```

默认访问地址为 `http://localhost:4321/`。

## 生产构建

```sh
npm run build
```

构建结果输出到 `dist/`。

## 预览生产版本

```sh
npm run preview
```

## 内容管理

博客文章存放在 `src/content/blog/`。Markdown 文件可以使用中文文件名，公开 URL 由文章 frontmatter 中的英文 `slug` 决定。

文章 frontmatter 示例：

```yaml
---
title: "文章标题"
description: "文章摘要"
pubDate: 2026-09-30
slug: "article-slug"
category: "学习记录"
tags:
  - C++
draft: false
---
```

## Cloudflare Pages

通过 Git 仓库连接 Cloudflare Pages 时使用以下配置：

- Framework preset：`Astro`
- Build command：`npm run build`
- Build output directory：`dist`
- Production branch：`main`

项目暂未配置正式域名，因此没有写死 `site` 或启用 sitemap。Cloudflare Pages 构建时，RSS 会使用平台提供的当前部署地址；后续绑定正式域名后再统一配置站点地址和 sitemap。
