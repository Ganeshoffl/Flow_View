def divide(a, b):
    return a / b

try:
    result = divide(1, 0)
except ZeroDivisionError:
    result = None

def later():
    return 42

check = later()
print(result, check)
