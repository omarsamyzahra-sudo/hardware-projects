// soc.c — console output through SYS PUTCHAR, and memcpy/memset
#include "soc.h"

void putch(char c) { SYS_PUTCHAR = (uint8_t)c; }

void puts_(const char *s) { while (*s) putch(*s++); }

void put_int(int32_t v) {
    char buf[12];
    int i = 0;
    uint32_t u = v < 0 ? -(uint32_t)v : (uint32_t)v;
    if (v < 0) putch('-');
    do { buf[i++] = '0' + u % 10; u /= 10; } while (u);
    while (i) putch(buf[--i]);
}

void put_hex(uint32_t v) {
    for (int i = 28; i >= 0; i -= 4) putch("0123456789abcdef"[(v >> i) & 0xF]);
}

void *memcpy(void *d, const void *s, unsigned n) {
    uint8_t *dp = d;
    const uint8_t *sp = s;
    while (n--) *dp++ = *sp++;
    return d;
}

void *memset(void *d, int c, unsigned n) {
    uint8_t *dp = d;
    while (n--) *dp++ = (uint8_t)c;
    return d;
}
