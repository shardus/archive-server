# The Shardus Archiver

This is a node that runs as part of the shardus network, with the function of
remembering the cycle chain and state data, depending on the app.

## Releasing

To release, just run `npm run release` :)

## Docker setup

> Make sure necessary components which are required to run archiver server are running by smoke testing stack in networking mode host

Start archiver

```shell
# Run services in attach mode
docker compose up
# OR
# Run services in detach mode
docker compose up -d
```

Check the logs

```shell
docker compose logs -f
```

Clean the setup

```shell
docker compose down
# remove db and logs
rm -r ./archiver-db ./archive-server
```
