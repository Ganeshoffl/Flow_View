#include <stdexcept>

struct Item { int value; };

int main() {
    Item *item = new Item{1};
    throw std::runtime_error("uncaught");
    delete item;
}
