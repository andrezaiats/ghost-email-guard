FROM node:20-alpine

WORKDIR /app

# Download blocklist snapshot at build time so the image works offline
ADD https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf /app/disposable_email_blocklist.conf

COPY package.json ./
RUN npm install --omit=dev

COPY blocklist.js server.js ./

EXPOSE 2369

CMD ["node", "server.js"]
