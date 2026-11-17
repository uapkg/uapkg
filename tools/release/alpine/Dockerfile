FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 AS runtime
# Runtime requirements only. No Node/npm, compiler, glibc, gcompat, or libc6-compat.
RUN apk add --no-cache ca-certificates git libstdc++ libgcc libatomic libsecret dbus gnome-keyring
WORKDIR /work

FROM runtime AS qualification
# readelf is qualification instrumentation, not a product runtime dependency.
RUN apk add --no-cache binutils bash

FROM qualification AS build
RUN apk add --no-cache tar xz
