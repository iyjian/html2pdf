FROM node:18.15.0-bullseye

ENV TZ Asia/Shanghai \
    DEBIAN_FRONTEND=noninteractive

ENV NODE_ENV development


# RUN sed -i s@http://security.debian.org@http://mirrors.aliyun.com@g /etc/apt/sources.list
# RUN sed -i s@http://deb.debian.org@http://mirrors.aliyun.com@g /etc/apt/sources.list

RUN npm install -g pnpm@9.14.4

RUN apt-get update -y

# RUN ln -fs /usr/share/zoneinfo/${TZ} /etc/localtime \
#     && echo ${TZ} > /etc/timezone \
#     && dpkg-reconfigure --frontend noninteractive tzdata \
#     && rm -rf /var/lib/apt/lists/*

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

WORKDIR /app

COPY fonts/* /usr/share/fonts/

RUN mkfontscale && mkfontdir && fc-cache

COPY package*.json ./
COPY pnpm-lock.yaml .
COPY .npmrc .

RUN pnpm i

COPY . ./

RUN yarn run build
