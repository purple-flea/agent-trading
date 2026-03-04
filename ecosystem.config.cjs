module.exports = {
  apps: [{
    name: "trading",
    script: "dist/server.js",
    cwd: "/home/dev/trading",
    env: {
      PORT: "3003",
    }
  }]
};
