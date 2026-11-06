FROM docker:28-dind
RUN apk add --no-cache python3 curl time
COPY driver.py /driver.py
ENTRYPOINT ["python3", "-u", "/driver.py"]
