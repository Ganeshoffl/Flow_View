public class Main {
    static int divide(int a, int b) {
        return a / b;
    }

    static int later() {
        return 42;
    }

    public static void main(String[] args) {
        Integer result;
        try {
            result = divide(1, 0);
        } catch (ArithmeticException error) {
            result = null;
        }
        int check = later();
        System.out.println(result + " " + check);
    }
}
