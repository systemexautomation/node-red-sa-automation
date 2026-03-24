FROM nodered/node-red:latest

USER root
WORKDIR /usr/src/node-red

# Install companion Node-RED packages (internet required at image build time / CI)
RUN npm install --unsafe-perm \
    @flowfuse/node-red-dashboard \
    node-red-node-snmp \
    node-red-contrib-postgresql \
    node-red-contrib-ipprint \
    node-red-contrib-cip-ethernet-ip \
    node-red-contrib-s7 \
    node-red-contrib-opcua \
    pdfkit

# Install the SA automation package from the pre-packed tgz
# (built by: npm pack, produces node-red-sa-automation-x.x.x.tgz)
COPY node-red-sa-automation-*.tgz .
RUN npm install --unsafe-perm node-red-sa-automation-*.tgz \
    && rm node-red-sa-automation-*.tgz

# Copy default flows (used on fresh deployments with empty /data volume)
COPY flows.json /data/flows.json

USER node
