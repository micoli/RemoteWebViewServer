ARG SERVER_IMAGE=docker.io/strangev/remote-webview-server:latest
FROM ${SERVER_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq socat ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ADD https://api.github.com/repos/micoli/RemoteWebViewServer/git/refs/heads/autofill-autoreconnect /dev/null

RUN mkdir -p /tmp/app;\
    git clone --depth 1 --branch autofill-autoreconnect https://github.com/micoli/RemoteWebViewServer /tmp/app;\
    cp /tmp/app/dist/* /app/dist/.

WORKDIR /app
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8081 18080 9221

CMD ["/run.sh"]
