FROM node:20-alpine

WORKDIR /root/task

COPY package.json ./
RUN npm install

COPY . .

RUN npm run build:client

EXPOSE 3000

CMD ["npm", "start"]
