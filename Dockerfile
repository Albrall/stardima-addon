FROM denoland/deno:2.1.4
WORKDIR /app
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["run", "--allow-net", "--allow-env", "deploy/deno/main.js"]
