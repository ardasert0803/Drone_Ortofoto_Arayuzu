FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    blender \
    ca-certificates \
    colmap \
    curl \
    nodejs \
    npm \
    openmvs \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g 3d-tiles-tools

WORKDIR /app
RUN mkdir -p /app/scripts
COPY run_indoor_job.py /app/scripts/run_indoor_job.py
COPY obj_to_glb.py /app/scripts/obj_to_glb.py

ENV PYTHONUNBUFFERED=1
