public class Main {
    public static void main(String[] args) {
        int score = 72;
        String grade;
        if (score >= 90) {
            grade = "A";
        } else if (score >= 70) {
            grade = "B";
        } else {
            grade = "C";
        }
        System.out.println(grade);
    }
}
