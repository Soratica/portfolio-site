FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html homelab.html 404.html /usr/share/nginx/html/
COPY projects/ /usr/share/nginx/html/projects/
COPY assets/ /usr/share/nginx/html/assets/
