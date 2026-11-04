#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <time.h>
#include <stdatomic.h>

static atomic_int fired;
static size_t delayed_fread(void *buffer, size_t size, size_t count, FILE *stream) {
    const char *wanted = getenv("DWCUE_STORAGE_STALL_PATH");
    const char *reads = getenv("DWCUE_STORAGE_STALL_READS");
    long limit = reads ? strtol(reads, NULL, 10) : 1;
    if (limit < 1) limit = 1;
    if (limit > 8) limit = 8;
    char path[PATH_MAX];
    if (wanted && fcntl(fileno(stream), F_GETPATH, path) == 0 &&
        strcmp(path, wanted) == 0 && atomic_fetch_add(&fired, 1) < limit) {
        const char *marker = getenv("DWCUE_STORAGE_STALL_ENTERED");
        if (marker) { int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0600); if (fd >= 0) close(fd); }
        long ms = 2500;
        const char *setting = getenv("DWCUE_STORAGE_STALL_MS");
        if (setting) ms = strtol(setting, NULL, 10);
        if (ms < 0) ms = 0;
        if (ms > 5000) ms = 5000;
        struct timespec delay = {ms / 1000, (ms % 1000) * 1000000};
        while (nanosleep(&delay, &delay) != 0) {}
    }
    return fread(buffer, size, count, stream);
}
__attribute__((used)) static const struct { const void *replacement; const void *original; }
interpose_fread __attribute__((section("__DATA,__interpose"))) = {
    (const void *)delayed_fread, (const void *)fread
};
