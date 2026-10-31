// soc.h — the SoC's memory map and a few console helpers (no libc)
#pragma once
#include <stdint.h>

#define SYS_BASE     0x50000000u
#define SYS_TOHOST   (*(volatile uint32_t *)(SYS_BASE + 0x00))
#define SYS_PUTCHAR  (*(volatile uint32_t *)(SYS_BASE + 0x04))
#define SYS_CYCLE    (*(volatile uint32_t *)(SYS_BASE + 0x08))
#define SYS_BUSERR   (*(volatile uint32_t *)(SYS_BASE + 0x0C))

static inline uint32_t cycles(void) { return SYS_CYCLE; }

void putch(char c);
void puts_(const char *s);
void put_int(int32_t v);
void put_hex(uint32_t v);

// gcc may call these for struct copies and zeroing, even freestanding
void *memcpy(void *d, const void *s, unsigned n);
void *memset(void *d, int c, unsigned n);
