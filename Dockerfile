FROM node:22.16.0-bookworm AS base

ENV TZ=Asia/Shanghai

ENV DEBIAN_FRONTEND=noninteractive

ENV NODE_ENV=development

# 依赖安装阶段不下载浏览器；下面会显式下载唯一需要的 chrome-headless-shell。
ENV PUPPETEER_CHROME_SKIP_DOWNLOAD=true
ENV PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

RUN npm install -g pnpm@10.6.5

# Debian bullseye 已于 2026-08-31 结束 LTS：bullseye-security 的 Packages 索引仍在，
# 但对应的 deb 包已从 deb.debian.org 下架，apt-get update 能过、apt-get install 却会
# 因 404 失败并返回 exit code 100。这里改用仍在维护的 bookworm（Debian 12），
# 同时按 bookworm 的包名更新：libgcc1 -> libgcc-s1，libappindicator3-1 -> libayatana-appindicator3-1。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fontconfig \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libayatana-appindicator3-1 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libgcc-s1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libnss3-dev \
        libnss3-tools \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libstdc++6 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        lsb-release \
        wget \
        xdg-utils \
        xfonts-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY fonts/* /usr/share/fonts/

RUN mkfontscale && mkfontdir && fc-cache

COPY package*.json ./
COPY pnpm-lock.yaml .
COPY .npmrc .

RUN pnpm install --frozen-lockfile

# 在镜像构建时下载 PDF 渲染使用的浏览器，运行期不需要联网下载。
# 此处临时解除 shell 的安装跳过配置，仅影响这一条显式安装命令。
RUN PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=false \
    pnpm exec puppeteer browsers install chrome-headless-shell

COPY . ./

RUN pnpm run build
