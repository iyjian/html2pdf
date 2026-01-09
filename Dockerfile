FROM node:22.16.0-bullseye AS base

ENV TZ=Asia/Shanghai 

ENV DEBIAN_FRONTEND=noninteractive

ENV NODE_ENV=development

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install -g pnpm

RUN apt-get update -y

RUN apt-get install -y   ca-certificates \
                                      fonts-liberation \
                                      libappindicator3-1 \
                                      libasound2 \
                                      libatk-bridge2.0-0 \
                                      libatk1.0-0 \
                                      libc6 \
                                      libcairo2 \
                                      libcups2 \
                                      libdbus-1-3 \
                                      libexpat1 \
                                      libfontconfig1 \
                                      libgbm1 \
                                      libgcc1 \
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
                                      xdg-utils

RUN apt-get install -y fontconfig xfonts-utils
RUN apt-get install -y chromium chromium-driver

WORKDIR /app

COPY fonts/* /usr/share/fonts/

RUN mkfontscale && mkfontdir && fc-cache

COPY package*.json ./
COPY pnpm-lock.yaml .
COPY .npmrc .

RUN pnpm i

COPY . ./

RUN pnpm run build
