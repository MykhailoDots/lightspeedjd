# jobdone-isolated-metric-importer

1) Install Docker: <https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository>

2) Create the `.env` file

3) Start Services

```bash
sudo docker compose up --build --force-recreate -d
sudo docker compose logs -f

sudo docker exec -it jobdone-isolated-metric-importer /bin/sh

sudo docker compose down
sudo docker compose down -v

### Bindella has different file

sudo docker compose -f docker-compose.bindella.yml up --build --force-recreate -d
sudo docker compose -f docker-compose.bindella.yml logs -f

sudo docker exec -it jobdone-isolated-metric-importer /bin/sh

sudo docker compose -f docker-compose.bindella.yml down
sudo docker compose -f docker-compose.bindella.yml down -v
```

## Testing

```bash
# run all tests
bun run test

# generate lcov coverage report to ./coverage/lcov.info
bun run test:coverage

# validate maintained runtime coverage threshold (index/core/sources/helper/util/config)
# excludes generated graphql files and test files
bun run coverage:check
```
