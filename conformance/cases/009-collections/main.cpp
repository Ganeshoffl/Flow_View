#include <iostream>
#include <vector>

int main() {
    std::vector<int> nums{10, 20, 30};
    std::vector<int> inner{9};
    std::vector<int> one{1};
    std::vector<int*> nested{nums.data(), inner.data()};
    std::vector<int> spare{0};
    nums[2] = 30;
    one[0] = 1;
    std::cout << nested[0][2] << ' ' << one[0] << ' ' << nested[1][0] << '\n';
    return 0;
}
