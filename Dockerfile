FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000

# The generated Worker bundle is self-contained. serve-worker.js adapts the
# standard Fetch API handler to a normal Node HTTP server for container hosts.
COPY package.json serve-worker.js worker-addon.js ./

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node
CMD ["node", "serve-worker.js"]
