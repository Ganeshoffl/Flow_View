#include <stdio.h>

int main(void) {
    int score = 75;
    char grade = '?';
    if (score >= 90) {
        grade = 'A';
    } else if (score >= 70) {
        grade = 'B';
    } else {
        grade = 'C';
    }
    printf("%c\n", grade);
    return 0;
}
