FROM nginx:alpine

RUN apk add --no-cache curl

WORKDIR /usr/share/nginx/html

COPY . .

RUN mkdir -p libs && \
    curl -L https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js \
      -o libs/qrcode.min.js && \
    curl -L https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js \
      -o libs/pako.min.js && \
    curl -L https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js \
      -o libs/html5-qrcode.min.js

EXPOSE 80