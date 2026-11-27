FROM python:3.12-alpine

WORKDIR /app
RUN apk add --no-cache su-exec && \
    addgroup -S collector && adduser -S -G collector collector && \
    mkdir -p /data

COPY collector.py /app/collector.py

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OSIRIS_COLLECTOR_DB_PATH=/data/news.sqlite3 \
    PORT=3000

EXPOSE 3000

# Railway-mounted volumes may be root-owned at first boot. The tiny entrypoint
# grants write access to this service's own mount, then drops root privileges.
CMD ["sh", "-c", "chown collector:collector /data && exec su-exec collector python -u /app/collector.py"]
