# Tiny buildable image for the web service.
FROM busybox:1.36
RUN mkdir -p /app && echo "sam-web v1 build marker" > /app/marker.txt
COPY index.html /app/index.html
CMD ["httpd", "-f", "-h", "/app", "-p", "80"]
