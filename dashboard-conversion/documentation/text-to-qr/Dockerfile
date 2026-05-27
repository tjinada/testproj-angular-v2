FROM nginx:alpine

RUN apk add --no-cache curl

WORKDIR /usr/share/nginx/html

COPY . .
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The app ships with local browser libraries in /libs so clients do not need internet.
# During build, Unraid can optionally refresh them. If the CDN is unavailable,
# the bundled local copies are kept and the build still works.
RUN mkdir -p libs && \
    curl -fsSL https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js -o libs/qrcode-local.js || true && \
    curl -fsSL https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js -o libs/pako.min.js || true && \
    curl -fsSL https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js -o libs/html5-qrcode.min.js || true

EXPOSE 80
