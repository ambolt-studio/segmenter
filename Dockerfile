FROM oven/bun:1
WORKDIR /app
COPY package.json tsconfig.json ./
RUN bun install --production
COPY src ./src
EXPOSE 3000
CMD ["bun", "src/index.ts"]