version: '3.8'

services:
  youtube-extractor:
    build: .
    container_name: youtube-data-extractor
    ports:
      - "8890:8890"
    environment:
      - NODE_ENV=production
      - PORT=8890
      - TZ=Asia/Shanghai
    volumes:
      - ./logs:/app/logs
      - ./data:/app/data
    restart: unless-stopped
    networks:
      - youtube-net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.youtube-extractor.rule=Host(`youtube-extractor.local`)"
      - "traefik.http.routers.youtube-extractor.entrypoints=web"
      - "traefik.http.services.youtube-extractor.loadbalancer.server.port=8890"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8890/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.1'
          memory: 128M

networks:
  youtube-net:
    driver: bridge

volumes:
  logs:
    driver: local
  data:
    driver: local