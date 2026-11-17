#include <iostream>
#include <stdexcept>

int later() { return 42; }

int main() {
    std::nullptr_t result = nullptr;
    try {
        throw std::runtime_error("handled");
    } catch (const std::runtime_error &) {
        // Execution resumes in the caller after the catch.
    }
    int check = later();
    std::cout << "null " << check << '\n';
    return 0;
}
