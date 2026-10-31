/* link.ld — everything in the SoC's 256 KiB RAM at address 0; stack at the top */
OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY { RAM (rwx) : ORIGIN = 0x00000000, LENGTH = 256K }

SECTIONS
{
    .text : { *(.text.start) *(.text .text.*) } > RAM
    .rodata : ALIGN(4) { *(.rodata .rodata.* .srodata .srodata.*) } > RAM
    .data : ALIGN(4) { *(.data .data.* .sdata .sdata.*) } > RAM
    .bss : ALIGN(4) {
        _bss_start = .;
        *(.bss .bss.* .sbss .sbss.* COMMON)
        . = ALIGN(4);
        _bss_end = .;
    } > RAM
    _end = .;
    _stack_top = ORIGIN(RAM) + LENGTH(RAM);
}
