/* A ring buffer. */
#include <stdlib.h>
#include <string.h>
#include "ring.h"

#define RING_MAX 64

typedef struct ring {
    char *data;
    size_t head;
    size_t len;
} ring_t;

enum ring_state { RING_OK, RING_FULL };

static size_t clamp(size_t v, size_t hi) {
    return v > hi ? hi : v;
}

/* Creates a ring. */
ring_t *ring_new(size_t cap) {
    if (cap == 0 || cap > RING_MAX) {
        return NULL;
    }
    ring_t *r = malloc(sizeof(ring_t));
    if (!r) return NULL;
    r->data = malloc(cap);
    r->head = 0;
    r->len = 0;
    return r;
}

int ring_push(ring_t *r, const char *src, size_t n) {
    if (r == NULL || src == NULL) {
        return -1;
    } else if (n == 0) {
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        while (r->len >= RING_MAX) {
            r->len--;
        }
        switch (src[i]) {
            case '\n':
                r->head = 0;
                break;
            case '\0':
                break;
            default:
                r->data[r->head++] = src[i];
        }
    }
    do {
        r->len = clamp(r->len, RING_MAX);
    } while (0);
    return (int)n;
}

void ring_free(ring_t *r) {
    if (r) {
        free(r->data);
        free(r);
    }
}
