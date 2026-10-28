// mnist.c — int8 MNIST MLP (784 -> 64 -> 10) on the SoC
//
// Classifies MNIST_N test images on the accelerator, 16 at a time, and
// checks every prediction against EXPECTED (the bit-exact Python model).
// Then runs one image on the CPU alone for the cycle comparison.
// Exit code = number of predictions that differ from the Python model.
#include "accel.h"
#include "mnist_data.h"
#include "soc.h"

static int8_t  H[16 * 64] __attribute__((aligned(4)));
static int32_t LOGITS[16 * 16];

static int argmax10(const int32_t *v) {
    int best = 0;
    for (int i = 1; i < 10; i++) if (v[i] > v[best]) best = i;
    return best;
}

// layer 1 then layer 2 for `rows` images starting at X; predictions into pred
static void forward(const int8_t *X, int rows, int on_accel, uint8_t *pred) {
    layer_t l1 = { rows, 784, 64, X, W1p, B1, L1_MULT, L1_SHIFT, 1, H, 0 };
    layer_t l2 = { rows, 64, 16, H, W2p, B2, 1, 0, 0, 0, LOGITS };
    if (on_accel) {
        if (accel_layer(&l1) | accel_layer(&l2)) puts_("BUSERR\n");
    } else {
        cpu_layer(&l1);
        cpu_layer(&l2);
    }
    for (int i = 0; i < rows; i++) pred[i] = argmax10(LOGITS + 16 * i);
}

int main(void) {
    static uint8_t pred[MNIST_N];
    puts_("mnist: 784-64-10 int8 MLP, ");
    put_int(MNIST_N);
    puts_(" test images\n");

    uint32_t t0 = cycles();
    for (int i = 0; i < MNIST_N; i += 16)
        forward(IMAGES + 784 * i, MNIST_N - i < 16 ? MNIST_N - i : 16, 1, pred + i);
    uint32_t t_acc = cycles() - t0;

    int diff = 0, correct = 0;
    for (int i = 0; i < MNIST_N; i++) {
        diff += pred[i] != EXPECTED[i];
        correct += pred[i] == LABELS[i];
    }
    puts_("accelerator: "); put_int(t_acc); puts_(" cycles for "); put_int(MNIST_N);
    puts_(" images ("); put_int(t_acc / MNIST_N); puts_(" per image)\n");
    puts_("correct "); put_int(correct); putch('/'); put_int(MNIST_N);
    puts_(", differ from the Python int8 model: "); put_int(diff); putch('\n');

    uint8_t p1;
    t0 = cycles();
    forward(IMAGES, 1, 0, &p1);
    uint32_t t_cpu = cycles() - t0;
    puts_("cpu only:    "); put_int(t_cpu); puts_(" cycles for 1 image (prediction ");
    put_int(p1); puts_(p1 == pred[0] ? ", same)\n" : ", DIFFERENT)\n");
    diff += p1 != pred[0];

    puts_("speedup per image: "); put_int(t_cpu / (t_acc / MNIST_N)); puts_("x\n");
    puts_(diff ? "FAIL\n" : "PASS\n");
    return diff;
}
